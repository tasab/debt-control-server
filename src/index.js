import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import rateLimit from '@fastify/rate-limit'
import { assertConfig, config } from './config.js'
import errorsPlugin from './plugins/errors.js'
import authPlugin from './plugins/auth.js'
import authRoutes from './routes/auth.js'
import walletRoutes from './routes/wallets.js'
import transferRoutes from './routes/transfers.js'
import fxRoutes from './routes/fx.js'
import businessRoutes from './routes/businesses.js'
import requestRoutes from './routes/requests.js'
import loanRoutes from './routes/loans.js'
import statsRoutes from './routes/stats.js'
import { startJobs } from './jobs/index.js'

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

  // Auth endpoints are the ones worth brute-forcing, so they get their own,
  // tighter bucket (PLATFORM_PLAN §8).
  await fastify.register(
    async (scope) => {
      await scope.register(rateLimit, { max: 20, timeWindow: '1 minute' })
      await scope.register(authRoutes)
    },
    { prefix: '/api' },
  )

  await fastify.register(
    async (scope) => {
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
    if (config.jobs.enabled) startJobs(fastify.log)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}
