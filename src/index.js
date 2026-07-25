import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import snapshotRoutes from './routes/snapshots.js'
import peopleRoutes from './routes/people.js'
import auditRoutes from './routes/audit.js'
import currencyRoutes from './routes/currencies.js'

const PORT = Number(process.env.PORT ?? 3001)
const HOST = process.env.HOST ?? '0.0.0.0'

const fastify = Fastify({ logger: true })

// Allow the Vite dev client to call the API cross-origin.
await fastify.register(cors, { origin: true })

fastify.get('/health', async () => ({ status: 'ok' }))

await fastify.register(snapshotRoutes, { prefix: '/api' })
await fastify.register(peopleRoutes, { prefix: '/api' })
await fastify.register(auditRoutes, { prefix: '/api' })
await fastify.register(currencyRoutes, { prefix: '/api' })

// In production, serve the built client from the same origin (no CORS/proxy).
// Run `npm run build` (client) first; if dist/ is absent (dev), this is skipped.
const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_DIST = resolve(__dirname, '../../client/dist')
if (existsSync(join(CLIENT_DIST, 'index.html'))) {
  await fastify.register(fastifyStatic, { root: CLIENT_DIST })
  // SPA fallback: send index.html for any non-API, non-file route so client-side
  // routing (React Router) works on refresh/deep-link.
  fastify.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith('/api')) {
      return reply.code(404).send({ message: 'Not found' })
    }
    return reply.sendFile('index.html')
  })
  fastify.log.info(`Serving client from ${CLIENT_DIST}`)
}

try {
  await fastify.listen({ port: PORT, host: HOST })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
