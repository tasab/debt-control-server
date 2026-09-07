import { z } from 'zod'
import { balanceHistory, exportCsv, summary } from '../domain/stats.ts'
import { currencyCode } from '../validation/common.ts'
import { money } from '../serialize.ts'
import type { FastifyInstance } from 'fastify'

const historyQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  currency: currencyCode.optional(),
})

export default async function statsRoutes(fastify: FastifyInstance) {
  fastify.get('/stats/balance-history', { preHandler: fastify.authenticate }, async (request) => {
    const query = historyQuery.parse(request.query)
    const points = await balanceHistory({ userId: request.user.id, ...query })
    return points.map((point) => ({
      date: point.date,
      totalBase: money(point.totalBase),
      kinds: Object.fromEntries(Object.entries(point.kinds).map(([k, v]) => [k, money(v)])),
      currencies: Object.fromEntries(
        Object.entries(point.currencies).map(([k, v]) => [k, money(v)]),
      ),
    }))
  })

  fastify.get('/stats/summary', { preHandler: fastify.authenticate }, async (request) => {
    const data = await summary(request.user.id)
    return {
      baseCurrency: data.baseCurrency,
      wallets: money(data.wallets),
      invested: money(data.invested),
      borrowed: money(data.borrowed),
      netWorth: money(data.netWorth),
    }
  })

  fastify.get('/stats/export.csv', { preHandler: fastify.authenticate }, async (request, reply) => {
    const csv = await exportCsv(request.user.id)
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="transactions.csv"')
      .send(csv)
  })
}
