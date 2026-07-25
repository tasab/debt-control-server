import * as domain from '../domain/businesses.ts'
import {
  createBusinessSchema,
  registerPatchSchema,
  registerSchema,
  internalTransferSchema,
  startingCapitalSchema,
} from '../validation/businesses.ts'
import { idempotencyKeyOf } from '../idempotency.ts'
import { iso, money } from '../serialize.ts'
import type { FastifyInstance } from 'fastify'

const serializeBusiness = (b: Record<string, any>) => ({
  id: b.id,
  name: b.name,
  description: b.description ?? null,
  baseCurrency: b.baseCurrency,
  isVerified: b.isVerified ?? false,
  createdAt: iso(b.createdAt),
})

const serializeRegister = (r: Record<string, any>) => ({
  id: r.id,
  name: r.name,
  currency: r.currency,
  isActive: r.isActive,
  balance: money(r.balance ?? 0n),
})


/** Routes that take an `:id` path parameter. */
type IdParams = { Params: { id: string } }

export default async function businessRoutes(fastify: FastifyInstance) {
  const borrower = fastify.guard(['borrow'])

  fastify.post('/businesses', { preHandler: borrower }, async (request, reply) => {
    const body = createBusinessSchema.parse(request.body)
    const business = await domain.createBusiness({ userId: request.user.id, ...body })
    return reply.code(201).send(serializeBusiness(business))
  })

  fastify.get('/businesses/me', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    const capital = await domain.currentStartingCapital(business.id)
    return {
      ...serializeBusiness(business),
      startingCapital: capital
        ? { amount: money(capital.amount), currency: capital.currency, effectiveFrom: iso(capital.effectiveFrom) }
        : null,
    }
  })

  fastify.put('/businesses/me/starting-capital', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    const body = startingCapitalSchema.parse(request.body)
    const row = await domain.setStartingCapital(business.id, body)
    return { amount: money(row.amount), currency: row.currency, effectiveFrom: iso(row.effectiveFrom) }
  })

  fastify.get('/businesses/me/dashboard', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    const data = await domain.dashboard(business.id)
    return {
      baseCurrency: data.baseCurrency,
      assets: money(data.assets),
      liabilities: money(data.liabilities),
      netWorth: money(data.netWorth),
      profit: money(data.profit),
      costOfCapitalBps: data.costOfCapitalBps,
      activeLoanCount: data.activeLoanCount,
      startingCapital: data.startingCapital
        ? {
            amount: money(data.startingCapital.amount),
            currency: data.startingCapital.currency,
            base: money(data.startingCapital.base),
          }
        : null,
      byCurrency: data.byCurrency.map((row) => ({
        currency: row.currency,
        wallets: money(row.wallets),
        registers: money(row.registers),
        debt: money(row.debt),
        walletsBase: money(row.walletsBase),
        registersBase: money(row.registersBase),
        debtBase: money(row.debtBase),
      })),
      // Surfaced so the UI can say "valued at a stale rate" instead of
      // silently showing a number nobody can trust.
      staleCodes: data.staleCodes,
    }
  })

  fastify.get('/businesses/me/registers', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    const rows = await domain.listRegisters(business.id)
    return rows.map(serializeRegister)
  })

  fastify.post('/businesses/me/registers', { preHandler: borrower }, async (request, reply) => {
    const business = await domain.businessOf(request.user.id)
    const body = registerSchema.parse(request.body)
    const row = await domain.createRegister(business.id, body)
    return reply.code(201).send(serializeRegister({ ...row, balance: 0n }))
  })

  fastify.patch<IdParams>('/businesses/me/registers/:id', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    const body = registerPatchSchema.parse(request.body)
    const row = await domain.updateRegister(business.id, request.params.id, body)
    return serializeRegister(row)
  })

  fastify.delete<IdParams>('/businesses/me/registers/:id', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    return domain.deleteRegister(business.id, request.params.id)
  })

  // Moving money between the owner's wallet, the business wallet and its
  // registers — including putting cash into a каса.
  fastify.post('/businesses/me/transfers', { preHandler: borrower }, async (request, reply) => {
    const business = await domain.businessOf(request.user.id)
    const body = internalTransferSchema.parse(request.body)
    const result = await domain.moveInternal({
      userId: request.user.id,
      businessId: business.id,
      ...body,
      idempotencyKey: idempotencyKeyOf(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ transactionId: result.transactionId })
  })

  fastify.get<IdParams>('/businesses/:id', { preHandler: fastify.authenticate }, async (request) => {
    const profile = await domain.publicProfile(request.params.id)
    return {
      ...serializeBusiness(profile),
      ownerName: profile.ownerName,
      rating: profile.rating,
      loansTotal: profile.loansTotal,
      loansClosed: profile.loansClosed,
    }
  })
}
