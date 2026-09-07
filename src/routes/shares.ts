import { z } from 'zod'
import { createShare, listShares, revokeShare, viewShare } from '../domain/shares.ts'
import { money, iso } from '../serialize.ts'
import { serializeWallet } from '../serialize.ts'
import type { FastifyInstance } from 'fastify'

const createBody = z.object({
  label: z.string().trim().max(60).optional(),
})

type IdParams = { Params: { id: string } }
type TokenParams = { Params: { token: string } }

const serializeShare = (row: Record<string, any>) => ({
  id: row.id,
  token: row.token,
  label: row.label,
  viewCount: row.viewCount,
  lastViewedAt: iso(row.lastViewedAt),
  revokedAt: iso(row.revokedAt),
  createdAt: iso(row.createdAt),
})

export default async function shareRoutes(fastify: FastifyInstance) {
  fastify.get('/shares', { preHandler: fastify.authenticate }, async (request) => {
    const rows = await listShares(request.user.id)
    return rows.map(serializeShare)
  })

  fastify.post('/shares', { preHandler: fastify.authenticate }, async (request, reply) => {
    const body = createBody.parse(request.body ?? {})
    const row = await createShare(request.user.id, body)
    return reply.code(201).send(serializeShare(row))
  })

  fastify.delete<IdParams>('/shares/:id', { preHandler: fastify.authenticate }, async (request) => {
    const row = await revokeShare(request.user.id, request.params.id)
    return serializeShare(row)
  })

  /**
   * Єдиний публічний ендпоінт із грошима — і єдиний, який можна перебирати,
   * тож у нього власний ліміт: 30 спроб на хвилину з адреси. Токен має 128
   * біт, і за такої швидкості перебір лишається неможливим не лише в теорії.
   */
  fastify.get<TokenParams>(
    '/shares/:token/balance',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request) => {
      const data = await viewShare(request.params.token)
      return {
        displayName: data.displayName,
        baseCurrency: data.baseCurrency,
        netWorth: money(data.netWorth),
        wallets: data.wallets.map(serializeWallet),
        generatedAt: iso(data.generatedAt),
      }
    },
  )
}
