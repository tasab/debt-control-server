import * as domain from '../domain/members.ts'
import { businessOf } from '../domain/businesses.ts'
import {
  acceptInviteSchema,
  claimTransferSchema,
  inviteSchema,
  rateSchema,
  withdrawSchema,
} from '../validation/members.ts'
import { idempotencyKeyOf } from '../idempotency.ts'
import { iso, money } from '../serialize.ts'
import type { FastifyInstance } from 'fastify'

const serializeBalances = (rows: Array<{ currency: string; balance: bigint }>) =>
  rows.map((row) => ({ currency: row.currency, balance: money(row.balance) }))

const serializeMember = (m: Record<string, any>) => ({
  id: m.id,
  businessId: m.businessId,
  userId: m.userId,
  status: m.status,
  displayName: m.displayName ?? null,
  email: m.email ?? null,
  businessName: m.businessName ?? null,
  rateAnnualBps: m.rate?.rateAnnualBps ?? 0,
  invitedAt: iso(m.invitedAt),
  joinedAt: iso(m.joinedAt),
  endedAt: iso(m.endedAt),
  balances: serializeBalances(m.balances ?? []),
})

const serializeContribution = (c: Record<string, any>) => ({
  id: c.id,
  memberId: c.memberId,
  displayName: c.displayName ?? null,
  direction: c.direction,
  currency: c.currency,
  amount: money(c.amount),
  status: c.status,
  note: c.note ?? null,
  transactionId: c.transactionId ?? null,
  declaredAt: iso(c.declaredAt),
  decidedAt: iso(c.decidedAt),
})

type IdParams = { Params: { id: string } }

export default async function memberRoutes(fastify: FastifyInstance) {
  const borrower = fastify.guard(['borrow'])
  const auth = fastify.authenticate

  // ─── Сторона власника ─────────────────────────────────────────────────────

  fastify.get('/businesses/me/members', { preHandler: borrower }, async (request) => {
    const business = await businessOf(request.user.id)
    const members = await domain.listMembers(business.id)
    return members.map(serializeMember)
  })

  fastify.post('/businesses/me/members', { preHandler: borrower }, async (request, reply) => {
    const business = await businessOf(request.user.id)
    const body = inviteSchema.parse(request.body)
    const member = await domain.invite(business.id, body.userId)
    return reply.code(201).send(serializeMember(member))
  })

  // Завершення участі повертає кошти на гаманець учасника — `returned` каже,
  // скільки саме, щоб було що показати замість самого лише «готово».
  fastify.delete<IdParams>('/businesses/me/members/:id', { preHandler: borrower }, async (request) => {
    const { member, returned } = await domain.endMembership(request.params.id, request.user.id)
    return {
      ...serializeMember(member),
      returned: returned.map((row) => ({ currency: row.currency, amount: money(row.amount) })),
    }
  })

  // «Видалити» означає прибрати зі списку: рядок лишається, бо на ньому
  // тримаються рахунки журналу.
  fastify.post<IdParams>('/businesses/me/members/:id/hide', { preHandler: borrower }, async (request) => {
    const member = await domain.hideMembership(request.params.id, request.user.id)
    return serializeMember(member)
  })

  fastify.put<IdParams>('/businesses/me/members/:id/rate', { preHandler: borrower }, async (request) => {
    await businessOf(request.user.id)
    const body = rateSchema.parse(request.body)
    const row = await domain.setRate(request.params.id, body.rateAnnualBps)
    return { rateAnnualBps: row.rateAnnualBps, effectiveFrom: iso(row.effectiveFrom) }
  })

  // Історія того, що зайшло в бізнес. Записів тут не робить ніхто вручну:
  // вони з'являються самі, коли учасник вступає і його кошти переходять.
  fastify.get('/businesses/me/contributions', { preHandler: borrower }, async (request) => {
    const business = await businessOf(request.user.id)
    const rows = await domain.listContributions({ businessId: business.id })
    return rows.map(serializeContribution)
  })

  // ─── Сторона учасника ─────────────────────────────────────────────────────

  fastify.get('/memberships', { preHandler: auth }, async (request) => {
    const rows = await domain.membershipsOf(request.user.id)
    return rows.map(serializeMember)
  })

  // Прийняття запрошення одразу переносить баланс гаманця в бізнес — `swept`
  // каже клієнту, скільки саме зайшло, щоб було що показати.
  fastify.post<IdParams>('/memberships/:id/accept', { preHandler: auth }, async (request) => {
    const body = acceptInviteSchema.parse(request.body)
    const { member, swept } = await domain.acceptInvite(
      request.params.id,
      request.user.id,
      body.rateAnnualBps,
    )
    return {
      ...serializeMember(member),
      swept: swept.map((row) => ({ currency: row.currency, amount: money(row.amount) })),
    }
  })

  // Відмова від запрошення. Нічого не рухає: кошти заходять лише при
  // прийнятті, тож і повертати тут нема чого.
  fastify.post<IdParams>('/memberships/:id/decline', { preHandler: auth }, async (request) => {
    const member = await domain.declineInvite(request.params.id, request.user.id)
    return serializeMember(member)
  })

  // Зняття коштів. Підтвердження власника не потрібне — він і так видає
  // готівку з каси, а додаток лише фіксує, що борг зменшився.
  fastify.post<IdParams>('/memberships/:id/withdrawals', { preHandler: auth }, async (request, reply) => {
    const body = withdrawSchema.parse(request.body)
    const result = await domain.withdraw({
      memberId: request.params.id,
      userId: request.user.id,
      ...body,
      idempotencyKey: idempotencyKeyOf(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ transactionId: result.transactionId })
  })

  // Передача вимоги іншому учаснику того самого бізнесу. Каси не рухаються.
  fastify.post<IdParams>('/memberships/:id/transfers', { preHandler: auth }, async (request, reply) => {
    const body = claimTransferSchema.parse(request.body)
    const result = await domain.transferClaim({
      memberId: request.params.id,
      userId: request.user.id,
      ...body,
      idempotencyKey: idempotencyKeyOf(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ transactionId: result.transactionId })
  })
}
