import { z } from 'zod'
import { getLoan, listLoans, repay } from '../domain/loans.js'
import { repaySchema } from '../validation/requests.js'
import { idempotencyKeyOf } from '../idempotency.js'
import { iso, money } from '../serialize.js'

const listQuery = z.object({
  role: z.enum(['borrower', 'investor']).default('investor'),
  status: z.string().optional(),
})

const serializeLoan = (loan) => ({
  id: loan.id,
  status: loan.status,
  currency: loan.currency,
  principal: money(loan.principal),
  outstandingPrincipal: money(loan.outstandingPrincipal),
  accruedInterest: money(loan.accruedInterest),
  paidInterest: money(loan.paidInterest),
  interestOutstanding: money(loan.interestOutstanding ?? 0n),
  rateAnnualBps: loan.rateAnnualBps,
  repaymentType: loan.repaymentType,
  disbursedAt: iso(loan.disbursedAt),
  maturesAt: iso(loan.maturesAt),
  closedAt: iso(loan.closedAt),
  myShareBps: loan.myShareBps ?? null,
  myPrincipalShare: loan.myPrincipalShare ? money(loan.myPrincipalShare) : null,
  nextPayment: loan.nextPayment
    ? {
        id: loan.nextPayment.id,
        dueAt: iso(loan.nextPayment.dueAt),
        principalDue: money(loan.nextPayment.principalDue),
        interestDue: money(loan.nextPayment.interestDue),
        status: loan.nextPayment.status,
      }
    : null,
})

export default async function loanRoutes(fastify) {
  fastify.get('/loans', { preHandler: fastify.authenticate }, async (request) => {
    const query = listQuery.parse(request.query)
    const result = await listLoans({ userId: request.user.id, ...query })
    return { items: result.items.map(serializeLoan) }
  })

  fastify.get('/loans/:id', { preHandler: fastify.authenticate }, async (request) => {
    const loan = await getLoan(request.params.id, request.user.id)
    return {
      ...serializeLoan(loan),
      business: loan.business,
      schedule: loan.schedule.map((row) => ({
        id: row.id,
        seq: row.seq,
        dueAt: iso(row.dueAt),
        principalDue: money(row.principalDue),
        interestDue: money(row.interestDue),
        principalPaid: money(row.principalPaid),
        interestPaid: money(row.interestPaid),
        status: row.status,
        paidAt: iso(row.paidAt),
      })),
      investors: loan.investors.map((i) => ({
        name: i.name,
        shareBps: i.shareBps,
        principalShare: money(i.principalShare),
        isMe: i.investorId === request.user.id,
      })),
    }
  })

  fastify.post('/loans/:id/repay', { preHandler: fastify.guard(['borrow']) }, async (request, reply) => {
    const { amount } = repaySchema.parse(request.body)
    const result = await repay({
      loanId: request.params.id,
      userId: request.user.id,
      amount,
      idempotencyKey: idempotencyKeyOf(request),
    })
    if (result.replayed) return reply.code(200).send({ transactionId: result.transactionId })
    return reply.code(201).send({
      transactionId: result.transactionId,
      principal: money(result.principal),
      interest: money(result.interest),
      fee: money(result.fee),
      closed: result.closed,
    })
  })
}
