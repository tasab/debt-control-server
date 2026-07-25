import { z } from 'zod'
import { balanceHistory, exportCsv, portfolio, summary } from '../domain/stats.js'
import { currencyCode } from '../validation/common.js'
import { money } from '../serialize.js'

const historyQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  currency: currencyCode.optional(),
})

export default async function statsRoutes(fastify) {
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
      held: money(data.held),
      lent: money(data.lent),
      accrued: money(data.accrued),
      overdue: money(data.overdue),
      borrowed: money(data.borrowed),
      netWorth: money(data.netWorth),
    }
  })

  fastify.get('/portfolio', { preHandler: fastify.guard(['invest']) }, async (request) => {
    const data = await portfolio(request.user.id)
    return {
      baseCurrency: data.baseCurrency,
      activePrincipal: money(data.activePrincipal),
      totalDeployed: money(data.totalDeployed),
      interestReceived: money(data.interestReceived),
      feesPaid: money(data.feesPaid),
      principalReturned: money(data.principalReturned),
      netInterest: money(data.netInterest),
      weightedRateBps: data.weightedRateBps,
      positionCount: data.positionCount,
      overdueCount: data.overdueCount,
      defaultedCount: data.defaultedCount,
      distribution: data.distribution.map((row) => ({
        businessId: row.id,
        name: row.name,
        amount: money(row.amount),
        shareBps: row.shareBps,
      })),
      concentrationWarning: data.concentrationWarning,
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
