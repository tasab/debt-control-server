import { eq } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { businesses, users } from '../../db/schema/index.ts'
import { config } from '../config.ts'
import { SESSION_COOKIE } from '../plugins/auth.ts'
import { loginSchema, registerSchema, searchSchema } from '../validation/auth.ts'
import * as auth from '../domain/auth.ts'
import { ratingFor } from '../domain/scoring.ts'
import { serializeUser } from '../serialize.ts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.isProduction,
  path: '/',
  maxAge: config.sessionTtlDays * 24 * 60 * 60,
}

export default async function authRoutes(fastify: FastifyInstance) {
  const context = (request: FastifyRequest) => ({
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  })

  const setSession = (reply: FastifyReply, user: { id: string }, session: { id: string }) => {
    const token = fastify.jwt.sign(
      { sub: user.id, sid: session.id },
      { expiresIn: `${config.sessionTtlDays}d` },
    )
    reply.setCookie(SESSION_COOKIE, token, cookieOptions)
  }

  // Guessing a password is the attack worth slowing down; every other route in
  // this file rides the app-wide limit (PLATFORM_PLAN §8).
  const bruteForceLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }

  fastify.post('/auth/register', bruteForceLimit, async (request, reply) => {
    const body = registerSchema.parse(request.body)
    const user = await auth.register(body, context(request))
    const session = await auth.createSession(user.id, context(request))
    setSession(reply, user, session)
    return reply.code(201).send(await mePayload(user))
  })

  fastify.post('/auth/login', bruteForceLimit, async (request, reply) => {
    const body = loginSchema.parse(request.body)
    const { user, session } = await auth.login(body, context(request))
    setSession(reply, user, session)
    return mePayload(user)
  })

  fastify.post(
    '/auth/logout',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      await auth.logout(request.user.sessionId)
      reply.clearCookie(SESSION_COOKIE, { path: '/' })
      return { ok: true }
    },
  )

  fastify.get('/auth/me', { preHandler: fastify.authenticate }, async (request) =>
    mePayload(request.user),
  )

  // Rotation is explicit: the client calls it when it wants a fresh cookie
  // (e.g. on app start). Rotating on every request would race with parallel
  // tabs and log people out at random.
  fastify.post('/auth/refresh', { preHandler: fastify.authenticate }, async (request, reply) => {
    const session = await auth.rotateSession(request.user.sessionId, context(request))
    setSession(reply, request.user, session)
    return mePayload(request.user)
  })

  fastify.get('/users/search', { preHandler: fastify.authenticate }, async (request) => {
    const { q } = searchSchema.parse(request.query)
    return auth.searchUsers({ query: q, excludeUserId: request.user.id })
  })
}

/** GET /auth/me payload — shared by register/login/refresh so all four agree. */
async function mePayload(user: { id: string }) {
  const [full] = await db.select().from(users).where(eq(users.id, user.id)).limit(1)
  const [business] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.ownerUserId, user.id))
    .limit(1)

  return serializeUser(full, {
    rating: await ratingFor(user.id),
    businessId: business?.id ?? null,
  })
}
