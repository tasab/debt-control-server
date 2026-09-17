import { createShare, listShares, revokeShare, viewShare } from '../domain/shares.ts'
import { money, iso } from '../serialize.ts'
import { serializeWallet } from '../serialize.ts'
import type { FastifyInstance } from 'fastify'

type IdParams = { Params: { id: string } }
type UserShareParams = { Params: { id: string; shareId: string } }
type TokenParams = { Params: { token: string } }

const serializeShare = (row: Record<string, any>) => ({
  id: row.id,
  token: row.token,
  viewCount: row.viewCount,
  lastViewedAt: iso(row.lastViewedAt),
  revokedAt: iso(row.revokedAt),
  createdAt: iso(row.createdAt),
  // Порожній, коли посилання зробив сам власник: підписувати «створив я» у
  // власному ж списку — зайвий шум.
  createdByName: row.createdBy && row.createdBy !== row.userId ? (row.createdByName ?? null) : null,
})

export default async function shareRoutes(fastify: FastifyInstance) {
  fastify.get('/shares', { preHandler: fastify.authenticate }, async (request) => {
    const rows = await listShares(request.user.id)
    return rows.map((row) => serializeShare({ ...row, userId: request.user.id }))
  })

  // Тіла немає навмисно: поділитися балансом — це один дотик, без полів.
  fastify.post('/shares', { preHandler: fastify.authenticate }, async (request, reply) => {
    const row = await createShare(request.user.id)
    return reply.code(201).send(serializeShare(row))
  })

  fastify.delete<IdParams>('/shares/:id', { preHandler: fastify.authenticate }, async (request) => {
    const row = await revokeShare(request.user.id, request.params.id)
    return serializeShare(row)
  })

  /**
   * Те саме, але для чужого балансу — з адмінки.
   *
   * Посилання належить тому, чий це баланс, а не тому, хто його створив: у
   * списку власника воно видно з позначкою, хто його зробив, і він може його
   * відкликати. Інакше людина мала б у себе запис, якого не робила й не може
   * прибрати.
   */
  fastify.get<IdParams>(
    '/admin/users/:id/shares',
    { preHandler: fastify.guard(['admin']) },
    async (request) => {
      const rows = await listShares(request.params.id)
      return rows.map((row) => serializeShare({ ...row, userId: request.params.id }))
    },
  )

  fastify.post<IdParams>(
    '/admin/users/:id/shares',
    { preHandler: fastify.guard(['admin']) },
    async (request, reply) => {
      const row = await createShare(request.params.id, { createdBy: request.user.id })
      return reply.code(201).send(serializeShare(row))
    },
  )

  fastify.delete<UserShareParams>(
    '/admin/users/:id/shares/:shareId',
    { preHandler: fastify.guard(['admin']) },
    async (request) => {
      const row = await revokeShare(request.params.id, request.params.shareId)
      return serializeShare(row)
    },
  )

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
        onWallets: money(data.onWallets),
        invested: money(data.invested),
        borrowed: money(data.borrowed),
        wallets: data.wallets.map(serializeWallet),
        generatedAt: iso(data.generatedAt),
      }
    },
  )
}
