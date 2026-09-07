import { z } from 'zod'
import {
  currentRates,
  execute,
  formatRate,
  MANUAL_SOURCE,
  quote,
  setManualRate,
} from '../fx/service.ts'
import { amountString, currencyCode } from '../validation/common.ts'
import { idempotencyKeyOf } from '../idempotency.ts'
import { iso, money } from '../serialize.ts'
import type { FastifyInstance } from 'fastify'

const quoteSchema = z.object({
  from: currencyCode,
  to: currencyCode,
  amountFrom: amountString,
})

const executeSchema = z.object({ quoteId: z.string().min(1) })

// Курс приходить як людина його пише: «44.2». Дробову частину бере parseRate.
const rateString = z.string().regex(/^\d+(\.\d+)?$/, 'напр. 44.20')

const manualRateSchema = z.object({
  quote: currencyCode,
  bid: rateString,
  sell: rateString,
})

const serializeQuote = (q: Record<string, any>) => ({
  quoteId: q.id,
  from: q.fromCurrency,
  to: q.toCurrency,
  amountFrom: money(q.amountFrom),
  amountTo: money(q.amountTo),
  rate: formatRate(q.rateUsed),
  side: q.side,
  expiresAt: iso(q.expiresAt),
})

export default async function fxRoutes(fastify: FastifyInstance) {
  fastify.get('/fx/rates', { preHandler: fastify.authenticate }, async () => {
    const rates = await currentRates()
    return rates.map((r) => ({
      code: r.quote,
      bid: formatRate(r.bid),
      sell: formatRate(r.sell),
      observedAt: iso(r.observedAt),
      isStale: r.isStale,
      // Свій курс чи зі стрічки — видно в інтерфейсі, щоб не гадати, чому
      // цифра не та, яку виставляли.
      isManual: r.sourceId === MANUAL_SOURCE,
    }))
  })

  // Власні курси обмінника. Перемагають стрічку й не старіють.
  fastify.put('/fx/rates', { preHandler: fastify.guard(['admin']) }, async (request) => {
    const body = manualRateSchema.parse(request.body)
    const row = await setManualRate(body)
    return {
      code: row.quote,
      bid: formatRate(row.bid),
      sell: formatRate(row.sell),
      observedAt: iso(row.observedAt),
      isManual: true,
    }
  })

  fastify.post('/fx/quote', { preHandler: fastify.authenticate }, async (request) => {
    const body = quoteSchema.parse(request.body)
    const created = await quote({ userId: request.user.id, ...body })
    return serializeQuote(created)
  })

  fastify.post('/fx/execute', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { quoteId } = executeSchema.parse(request.body)
    const result = await execute({
      userId: request.user.id,
      quoteId,
      idempotencyKey: idempotencyKeyOf(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ transactionId: result.transactionId })
  })
}
