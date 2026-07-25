import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import rateLimit from '@fastify/rate-limit'
import { assertConfig, config } from './config.ts'
import errorsPlugin from './plugins/errors.ts'
import authPlugin from './plugins/auth.ts'
import authRoutes from './routes/auth.ts'
import walletRoutes from './routes/wallets.ts'
import transferRoutes from './routes/transfers.ts'
import fxRoutes from './routes/fx.ts'
import businessRoutes from './routes/businesses.ts'
import requestRoutes from './routes/requests.ts'
import loanRoutes from './routes/loans.ts'
import statsRoutes from './routes/stats.ts'
import { startJobs } from './jobs/index.ts'

assertConfig()

export async function buildServer({ logger = true } = {}) {
  const fastify = Fastify({ logger, trustProxy: true })

  await fastify.register(cors, { origin: true, credentials: true })
  await fastify.register(rateLimit, {
    global: false,
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.user?.id ?? request.ip,
  })
  await fastify.register(errorsPlugin)
  await fastify.register(authPlugin)

  fastify.get('/health', async () => ({ status: 'ok' }))

  // The tight bucket belongs on the brute-forceable endpoints only (login and
  // register — see routes/auth.js), not on the whole auth prefix: `/auth/me`
  // runs on every page load, and sharing a 20/min bucket with it locked people
  // out of logging in.
  await fastify.register(
    async (scope) => {
      await scope.register(authRoutes)
      await scope.register(walletRoutes)
      await scope.register(transferRoutes)
      await scope.register(fxRoutes)
      await scope.register(businessRoutes)
      await scope.register(requestRoutes)
      await scope.register(loanRoutes)
      await scope.register(statsRoutes)
    },
    { prefix: '/api' },
  )

  // In production the built client is served from the same origin (no CORS, no
  // proxy). Skipped in dev, where Vite serves it.
  const here = dirname(fileURLToPath(import.meta.url))
  const clientDist = resolve(here, '../../client/dist')
  const hasClient = existsSync(join(clientDist, 'index.html'))
  if (hasClient) {
    await fastify.register(fastifyStatic, { root: clientDist })
    fastify.log.info(`Serving client from ${clientDist}`)
  }

  // One 404 handler for the whole app: JSON under /api, SPA fallback elsewhere
  // so a deep link still loads the client and React Router takes over.
  fastify.setNotFoundHandler((request, reply) => {
    if (!hasClient || request.raw.url?.startsWith('/api')) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Не знайдено', fields: null } })
    }
    return reply.sendFile('index.html')
  })

  return fastify
}

// `node src/index.js` starts the server; importing this module (tests) does not.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const fastify = await buildServer()
  try {
    await fastify.listen({ port: config.port, host: config.host })
    if (config.jobs.enabled) startJobs(fastify.log as unknown as Partial<Console>)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}
