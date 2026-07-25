import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.ts'
import {
  auditLog,
  businesses,
  fundingRequests,
  fundings,
  users,
} from '../../db/schema/index.ts'
import { errors } from '../errors.ts'
import { newId, parseAmount } from '../money/amount.ts'
import { postTransaction } from '../money/ledger.ts'
import { userHold, userWallet } from '../money/accounts.ts'
import { decodeCursor, encodeCursor } from '../serialize.ts'
import { scoreBusiness } from './scoring.ts'
import { disburseLoan } from './loans.ts'
import { transition } from './requestState.ts'
import type { LedgerEntryInput, Money, RepaymentType, RequestStatus, Tx } from '../types.ts'

export type FundingRequest = typeof fundingRequests.$inferSelect
export type Funding = typeof fundings.$inferSelect

export interface CreateRequestInput {
  currency: string
  amountTarget: string
  rateAnnualBps: number
  termDays: number
  repaymentType: RepaymentType
  minTicket?: string
  minFillBps?: number
  purpose?: string
  expiresAt: string
}

export interface ListRequestsQuery {
  limit?: number
  cursor?: string
  currency?: string
  minRate?: number
  maxTermDays?: number
  minGrade?: string
  status?: RequestStatus
}

export async function createRequest(
  businessId: string,
  input: CreateRequestInput,
): Promise<FundingRequest> {
  const amountTarget = parseAmount(input.amountTarget, { field: 'amountTarget' })
  const minTicket = parseAmount(input.minTicket ?? '10000', { field: 'minTicket' })
  if (minTicket > amountTarget) {
    throw errors.validation('Мінімальний внесок більший за суму заявки', {
      minTicket: 'зменште мінімальний внесок',
    })
  }
  const expiresAt = new Date(input.expiresAt)
  if (expiresAt.getTime() <= Date.now()) {
    throw errors.validation('Дедлайн має бути в майбутньому', { expiresAt: 'оберіть пізнішу дату' })
  }

  const [row] = await db
    .insert(fundingRequests)
    .values({
      id: newId('req'),
      businessId,
      currency: input.currency,
      amountTarget,
      rateAnnualBps: input.rateAnnualBps,
      termDays: input.termDays,
      repaymentType: input.repaymentType,
      minTicket,
      minFillBps: input.minFillBps ?? 5000,
      purpose: input.purpose ?? null,
      status: 'open',
      expiresAt,
    })
    .returning()
  return row
}

export async function listRequests(query: ListRequestsQuery = {}) {
  const { limit = 50, cursor, currency, minRate, maxTermDays, minGrade, status = 'open' } = query
  const cursorValue = decodeCursor(cursor)

  const conditions = [eq(fundingRequests.status, status)]
  if (currency) conditions.push(eq(fundingRequests.currency, currency))
  if (minRate) conditions.push(sql`${fundingRequests.rateAnnualBps} >= ${Number(minRate)}`)
  if (maxTermDays) conditions.push(sql`${fundingRequests.termDays} <= ${Number(maxTermDays)}`)
  if (cursorValue) {
    conditions.push(
      sql`(${fundingRequests.createdAt}, ${fundingRequests.id}) < (${new Date(cursorValue.createdAt)}, ${cursorValue.id})`,
    )
  }

  const rows = await db
    .select({
      request: fundingRequests,
      business: businesses,
      investorCount: sql`(SELECT COUNT(DISTINCT investor_id) FROM fundings f
                          WHERE f.request_id = ${fundingRequests.id} AND f.status = 'held')`,
    })
    .from(fundingRequests)
    .innerJoin(businesses, eq(businesses.id, fundingRequests.businessId))
    .where(and(...conditions))
    .orderBy(desc(fundingRequests.createdAt), desc(fundingRequests.id))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const items: Array<FundingRequest & { business: unknown; investorCount: number }> = []
  for (const row of page) {
    const rating = await scoreBusiness(row.business)
    // Grade filtering happens after scoring because the score is derived, not
    // stored — keeping it in SQL would mean caching a number that goes stale.
    if (minGrade && !gradeAtLeast(rating.grade, minGrade)) continue
    items.push({
      ...row.request,
      business: { id: row.business.id, name: row.business.name, rating },
      investorCount: Number(row.investorCount ?? 0),
    })
  }

  const last = rows.length > limit ? page.at(-1)?.request : undefined
  return {
    items,
    nextCursor: last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  }
}

const GRADES = ['D', 'C', 'B', 'A']
const gradeAtLeast = (grade: string, minimum: string) =>
  GRADES.indexOf(grade) >= GRADES.indexOf(minimum)

export async function getRequest(requestId: string, viewerId: string | null = null) {
  const [row] = await db
    .select({ request: fundingRequests, business: businesses })
    .from(fundingRequests)
    .innerJoin(businesses, eq(businesses.id, fundingRequests.businessId))
    .where(eq(fundingRequests.id, requestId))
    .limit(1)
  if (!row) throw errors.notFound('Заявку')

  const rating = await scoreBusiness(row.business)
  // §12: the business sees who funded it — visible participation builds trust.
  const investors = await db
    .select({
      id: fundings.id,
      investorId: fundings.investorId,
      name: users.displayName,
      amount: fundings.amount,
      status: fundings.status,
      createdAt: fundings.createdAt,
    })
    .from(fundings)
    .innerJoin(users, eq(users.id, fundings.investorId))
    .where(and(eq(fundings.requestId, requestId), eq(fundings.status, 'held')))
    .orderBy(desc(fundings.createdAt))

  return {
    ...row.request,
    business: { id: row.business.id, name: row.business.name, rating },
    investors,
    myFunding: viewerId ? (investors.find((i) => i.investorId === viewerId) ?? null) : null,
  }
}

/**
 * Fund a request. The money moves into the investor's own hold account — escrow
 * (§6.2), so it cannot be spent again while the request fills, and it is still
 * theirs if the request expires.
 */
export async function fundRequest({
  requestId,
  investorId,
  amount,
  idempotencyKey,
}: {
  requestId: string
  investorId: string
  amount: string
  idempotencyKey?: string | null
}): Promise<{ replayed?: boolean; transactionId?: string; funding?: Funding; filled?: boolean }> {
  const value = parseAmount(amount)

  const outcome = await db.transaction(async (tx) => {
    // Lock the request: two investors racing for the last slot must not both
    // win. Everything below is decided against this locked row.
    const locked = await tx.execute(
      sql`SELECT * FROM funding_requests WHERE id = ${requestId} FOR UPDATE`,
    )
    const request = (locked.rows ?? locked)[0] as Record<string, any> | undefined
    if (!request) throw errors.notFound('Заявку')
    if (request.status !== 'open') throw errors.requestNotOpen()
    if (new Date(request.expires_at).getTime() < Date.now()) throw errors.requestNotOpen()

    const target = BigInt(request.amount_target)
    const funded = BigInt(request.amount_funded)
    const remaining = target - funded
    const minTicket = BigInt(request.min_ticket)

    if (value < minTicket && value !== remaining) {
      throw errors.belowMinTicket({ amount: `мінімум ${minTicket} мінорних одиниць` })
    }
    if (value > remaining) {
      throw errors.overfunded({ amount: `залишилось ${remaining} мінорних одиниць` })
    }

    const currency = request.currency
    const wallet = await userWallet(investorId, currency, tx)
    const hold = await userHold(investorId, currency, tx)

    const posted = await postTransaction(
      {
        type: 'funding_hold',
        idempotencyKey,
        actorId: investorId,
        meta: { requestId },
        entries: [
          {
            accountId: wallet.id,
            currency,
            amount: -value,
            entryType: 'funding_hold',
            comment: 'заморожено під заявку',
          },
          { accountId: hold.id, currency, amount: value, entryType: 'funding_hold' },
        ],
      },
      tx,
    )
    if (posted.replayed) return { replayed: true, transactionId: posted.transactionId }

    const [funding] = await tx
      .insert(fundings)
      .values({
        id: newId('fnd'),
        requestId,
        investorId,
        amount: value,
        status: 'held',
        holdTxId: posted.transactionId,
      })
      .returning()

    const newFunded = funded + value
    await tx
      .update(fundingRequests)
      .set({ amountFunded: newFunded })
      .where(eq(fundingRequests.id, requestId))

    await tx.insert(auditLog).values({
      id: newId('aud'),
      actorId: investorId,
      action: 'funding.create',
      entity: 'funding',
      entityId: funding.id,
      data: { requestId, amount: value.toString() },
    })

    return { funding, filled: newFunded >= target }
  })

  // Reaching 100% disburses immediately — a separate transaction so a failure
  // here leaves the holds intact and retryable rather than half-applied.
  if (outcome.filled) await disburseLoan(requestId)

  return outcome
}

/** An investor pulls out before the request fills: the hold goes straight back. */
export async function cancelFunding({
  fundingId,
  investorId,
}: {
  fundingId: string
  investorId: string
}) {
  return db.transaction(async (tx) => {
    const [funding] = await tx
      .select()
      .from(fundings)
      .where(and(eq(fundings.id, fundingId), eq(fundings.investorId, investorId)))
      .limit(1)
    if (!funding) throw errors.notFound('Внесок')
    if (funding.status !== 'held') throw errors.conflict('FUNDING_NOT_HELD', 'Внесок уже закрито')

    const locked = await tx.execute(
      sql`SELECT * FROM funding_requests WHERE id = ${funding.requestId} FOR UPDATE`,
    )
    const request = (locked.rows ?? locked)[0] as Record<string, any>
    if (request.status !== 'open') throw errors.requestNotOpen()

    await releaseHold(tx, {
      funding,
      currency: request.currency,
      type: 'funding_release',
      comment: 'внесок скасовано',
    })

    await tx
      .update(fundings)
      .set({ status: 'cancelled', closedAt: new Date() })
      .where(eq(fundings.id, fundingId))
    await tx
      .update(fundingRequests)
      .set({ amountFunded: BigInt(request.amount_funded) - funding.amount })
      .where(eq(fundingRequests.id, funding.requestId))

    return { ok: true }
  })
}

/** Cancelling a request must return every hold — none may be left behind. */
export async function cancelRequest({
  requestId,
  businessId,
}: {
  requestId: string
  businessId: string
}) {
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(fundingRequests)
      .where(and(eq(fundingRequests.id, requestId), eq(fundingRequests.businessId, businessId)))
      .limit(1)
    if (!request) throw errors.notFound('Заявку')

    await refundAllHolds(tx, request, 'заявку скасовано')
    await transition(tx, request, 'cancelled', { closedAt: new Date(), amountFunded: 0n })
    return { ok: true }
  })
}

export async function refundAllHolds(
  tx: Tx,
  request: { id: string; currency: string },
  reason: string,
): Promise<number> {
  const held = await tx
    .select()
    .from(fundings)
    .where(and(eq(fundings.requestId, request.id), eq(fundings.status, 'held')))

  for (const funding of held) {
    await releaseHold(tx, {
      funding,
      currency: request.currency,
      type: 'funding_release',
      comment: reason,
    })
    await tx
      .update(fundings)
      .set({ status: 'refunded', closedAt: new Date() })
      .where(eq(fundings.id, funding.id))
  }
  return held.length
}

async function releaseHold(
  tx: Tx,
  {
    funding,
    currency,
    type,
    comment,
  }: { funding: Funding; currency: string; type: string; comment: string },
) {
  const wallet = await userWallet(funding.investorId, currency, tx)
  const hold = await userHold(funding.investorId, currency, tx)
  return postTransaction(
    {
      type,
      actorId: funding.investorId,
      meta: { fundingId: funding.id, requestId: funding.requestId },
      entries: [
        { accountId: hold.id, currency, amount: -funding.amount, entryType: type },
        { accountId: wallet.id, currency, amount: funding.amount, entryType: type, comment },
      ],
    },
    tx,
  )
}

/**
 * Deadline sweep (called by the expiry job): reaching min_fill disburses what
 * was collected, otherwise every hold is returned (§12 default).
 */
export async function settleExpiredRequests(log: Partial<Console> = console): Promise<number> {
  const due = await db
    .select()
    .from(fundingRequests)
    .where(and(eq(fundingRequests.status, 'open'), sql`${fundingRequests.expiresAt} <= now()`))

  for (const request of due) {
    const fillBps = Number((request.amountFunded * 10000n) / request.amountTarget)
    if (request.amountFunded > 0n && fillBps >= request.minFillBps) {
      await disburseLoan(request.id)
      log.info?.({ requestId: request.id, fillBps }, 'request: disbursed at deadline')
    } else {
      await db.transaction(async (tx) => {
        await refundAllHolds(tx, request, 'заявка не зібрала мінімум')
        await transition(tx, request, 'expired', { closedAt: new Date() })
      })
      log.info?.({ requestId: request.id, fillBps }, 'request: expired, holds returned')
    }
  }
  return due.length
}
