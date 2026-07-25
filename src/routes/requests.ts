import * as requests from '../domain/requests.ts'
import { businessOf } from '../domain/businesses.ts'
import { createRequestSchema, fundSchema, listRequestsSchema } from '../validation/requests.ts'
import { idempotencyKeyOf } from '../idempotency.ts'
import { iso, money } from '../serialize.ts'
import type { FastifyInstance } from 'fastify'

const serializeRequest = (r: Record<string, any>) => ({
  id: r.id,
  business: r.business
    ? { id: r.business.id, name: r.business.name, rating: r.business.rating }
    : { id: r.businessId },
  currency: r.currency,
  amountTarget: money(r.amountTarget),
  amountFunded: money(r.amountFunded),
  // Progress as basis points, computed server-side — the client never divides
  // money (CLIENT_PLAN §0).
  fundedBps:
    r.amountTarget > 0n ? Number((r.amountFunded * 10000n) / r.amountTarget) : 0,
  rateAnnualBps: r.rateAnnualBps,
  termDays: r.termDays,
  repaymentType: r.repaymentType,
  minTicket: money(r.minTicket),
  minFillBps: r.minFillBps,
  purpose: r.purpose,
  status: r.status,
  expiresAt: iso(r.expiresAt),
  createdAt: iso(r.createdAt),
  investorCount: r.investorCount ?? (r.investors?.length ?? 0),
})


/** Routes that take an `:id` path parameter. */
type IdParams = { Params: { id: string } }

export default async function requestRoutes(fastify: FastifyInstance) {
  fastify.get('/funding-requests', { preHandler: fastify.authenticate }, async (request) => {
    const query = listRequestsSchema.parse(request.query)
    const page = await requests.listRequests(query)
    return { items: page.items.map(serializeRequest), nextCursor: page.nextCursor }
  })

  fastify.post(
    '/funding-requests',
    { preHandler: fastify.guard(['borrow']) },
    async (request, reply) => {
      const business = await businessOf(request.user.id)
      const body = createRequestSchema.parse(request.body)
      const created = await requests.createRequest(business.id, body)
      return reply.code(201).send(serializeRequest(created))
    },
  )

  fastify.get<IdParams>('/funding-requests/:id', { preHandler: fastify.authenticate }, async (request) => {
    const found = await requests.getRequest(request.params.id, request.user.id)
    return {
      ...serializeRequest(found),
      investors: found.investors.map((i: Record<string, any>) => ({
        id: i.id,
        name: i.name,
        amount: money(i.amount),
        createdAt: iso(i.createdAt),
        isMe: i.investorId === request.user.id,
      })),
      myFunding: found.myFunding
        ? { id: found.myFunding.id, amount: money(found.myFunding.amount) }
        : null,
    }
  })

  fastify.post<IdParams>(
    '/funding-requests/:id/cancel',
    { preHandler: fastify.guard(['borrow']) },
    async (request) => {
      const business = await businessOf(request.user.id)
      return requests.cancelRequest({ requestId: request.params.id, businessId: business.id })
    },
  )

  fastify.post<IdParams>(
    '/funding-requests/:id/fundings',
    { preHandler: fastify.guard(['invest']) },
    async (request, reply) => {
      const { amount } = fundSchema.parse(request.body)
      const result = await requests.fundRequest({
        requestId: request.params.id,
        investorId: request.user.id,
        amount,
        idempotencyKey: idempotencyKeyOf(request),
      })
      if (result.replayed || !result.funding) return reply.code(200).send({ replayed: true })
      return reply.code(201).send({
        fundingId: result.funding.id,
        held: money(result.funding.amount),
        filled: result.filled,
      })
    },
  )

  fastify.delete<IdParams>('/fundings/:id', { preHandler: fastify.guard(['invest']) }, async (request) =>
    requests.cancelFunding({ fundingId: request.params.id, investorId: request.user.id }),
  )
}
