import { transfer, topUp } from '../domain/transfers.js'
import { previewFee } from '../money/fees.js'
import { parseAmount } from '../money/amount.js'
import { feePreviewSchema, topUpSchema, transferSchema } from '../validation/transfers.js'
import { money } from '../serialize.js'
import { idempotencyKeyOf } from '../idempotency.js'

export default async function transferRoutes(fastify) {
  fastify.post('/transfers', { preHandler: fastify.authenticate }, async (request, reply) => {
    const body = transferSchema.parse(request.body)
    const result = await transfer(
      {
        fromUserId: request.user.id,
        ...body,
        idempotencyKey: idempotencyKeyOf(request),
      },
      { ip: request.ip, userAgent: request.headers['user-agent'] },
    )
    return reply
      .code(result.replayed ? 200 : 201)
      .send({ transactionId: result.transactionId, fee: money(result.fee) })
  })

  // Shown in the confirmation step — the user must see the fee before, not
  // after (PLATFORM_PLAN §2.4).
  fastify.get('/fees/preview', { preHandler: fastify.authenticate }, async (request) => {
    const { kind, currency, amount } = feePreviewSchema.parse(request.query)
    const quote = await previewFee({ kind, currency, amount: parseAmount(amount) })
    return {
      amount: money(quote.amount),
      fee: money(quote.fee),
      total: money(quote.total),
      received: money(quote.received),
      payer: quote.payer,
    }
  })

  fastify.post(
    '/admin/topups',
    { preHandler: fastify.guard(['admin']) },
    async (request, reply) => {
      const body = topUpSchema.parse(request.body)
      const result = await topUp({
        adminId: request.user.id,
        ...body,
        idempotencyKey: idempotencyKeyOf(request),
      })
      return reply.code(result.replayed ? 200 : 201).send({ transactionId: result.transactionId })
    },
  )
}
