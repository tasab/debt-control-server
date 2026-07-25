import fp from 'fastify-plugin'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { sessions, users } from '../../db/schema/index.ts'
import { config } from '../config.ts'
import { errors } from '../errors.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuthUser, Capability } from '../types.ts'

export const SESSION_COOKIE = 'sid'

/**
 * Auth as a decorator, not middleware sprinkled per route:
 *   request.user          — the authenticated user or null
 *   fastify.authenticate  — preHandler that requires a session
 *   fastify.guard([caps])  — preHandler that requires capabilities
 *
 * The cookie holds a JWT whose `sid` names a row in `sessions`, so logout and
 * rotation revoke access immediately instead of waiting out the JWT lifetime.
 */
export default fp(async function authPlugin(fastify: FastifyInstance) {
  await fastify.register(cookie)
  await fastify.register(jwt, {
    secret: config.jwtSecret,
    cookie: { cookieName: SESSION_COOKIE, signed: false },
  })

  // @fastify/jwt already decorates request.user (with the raw JWT payload);
  // resolveUser overwrites it with the database row, so no second decorator.

  fastify.decorate('authenticate', async function authenticate(request: FastifyRequest) {
    const user = await resolveUser(request)
    if (!user) throw errors.unauthorized()
    request.user = user
  })

  // Attaches the user when a valid session exists, but never rejects — for
  // endpoints that are public yet render differently when signed in.
  fastify.decorate('optionalAuth', async function optionalAuth(request: FastifyRequest) {
    request.user = (await resolveUser(request)) as AuthUser
  })

  fastify.decorate('guard', function guard(required: Array<Capability | 'admin'> = []) {
    return async function guardHandler(request: FastifyRequest) {
      const user = await resolveUser(request)
      if (!user) throw errors.unauthorized()
      request.user = user
      for (const capability of required) {
        if (capability === 'admin') {
          if (!user.isAdmin) throw errors.forbidden('Потрібні права адміністратора')
          continue
        }
        if (!user.capabilities.includes(capability)) {
          throw errors.forbiddenCapability(capability)
        }
      }
    }
  })

  async function resolveUser(request: FastifyRequest): Promise<AuthUser | null> {
    let payload: { sub?: string; sid?: string } | undefined
    try {
      payload = await request.jwtVerify<{ sub?: string; sid?: string }>()
    } catch {
      return null
    }
    if (!payload?.sub || !payload?.sid) return null

    const [row] = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        capabilities: users.capabilities,
        isAdmin: users.isAdmin,
        sessionId: sessions.id,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.id, payload.sid),
          eq(sessions.userId, payload.sub),
          isNull(sessions.revokedAt),
          isNull(users.deletedAt),
        ),
      )
      .limit(1)

    if (!row) return null
    if (row.expiresAt.getTime() < Date.now()) return null
    return row as AuthUser
  }
})
