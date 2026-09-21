import { transfer, topUp, withdrawSelf } from '../domain/transfers.ts'
import { previewFee } from '../money/fees.ts'
import { parseAmount } from '../money/amount.ts'
import {
  feePreviewSchema,
  selfTopUpSchema,
  selfWithdrawalSchema,
  topUpSchema,
  transferSchema,
} from '../validation/transfers.ts'
import { money } from '../serialize.ts'
import { idempotencyKeyOf } from '../idempotency.ts'
import type { FastifyInstance } from 'fastify'

export default async function transferRoutes(fastify: FastifyInstance) {
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

  /**
   * Своє поповнення: людина записує власні кошти сама, без адміністратора.
   *
   * Чужий рахунок назвати нема як — id береться із сесії, а не з тіла запиту,
   * тож цей ендпоінт не дає покласти гроші комусь іншому навіть навмисне.
   * У виписці проводка має власний тип (`self_topup`), і видно, що суму вписав
   * власник рахунку, а не адміністратор.
   */
  fastify.post('/topups', { preHandler: fastify.authenticate }, async (request, reply) => {
    const body = selfTopUpSchema.parse(request.body)
    const result = await topUp({
      adminId: request.user.id,
      userId: request.user.id,
      ...body,
      self: true,
      idempotencyKey: idempotencyKeyOf(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ transactionId: result.transactionId })
  })

  /**
   * Зняти власні кошти — дзеркало `/topups`.
   *
   * Гроші виходять із реєстру, і у виписці це окремий тип (`self_withdrawal`),
   * а не від'ємне поповнення. Більше за доступне зняти не вийде: журнал не
   * дає гаманцю піти в мінус.
   */
  fastify.post('/withdrawals', { preHandler: fastify.authenticate }, async (request, reply) => {
    const body = selfWithdrawalSchema.parse(request.body)
    const result = await withdrawSelf({
      userId: request.user.id,
      ...body,
      idempotencyKey: idempotencyKeyOf(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ transactionId: result.transactionId })
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
