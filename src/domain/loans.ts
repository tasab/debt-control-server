import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.ts'
import {
  auditLog,
  businesses,
  fundings,
  loanShares,
  loans,
  repayments,
  repaymentSplits,
  users,
} from '../../db/schema/index.ts'
import { errors } from '../errors.ts'
import {
  divFloor,
  min as minOf,
  newId,
  parseAmount,
  splitProportionally,
} from '../money/amount.ts'
import { postTransaction } from '../money/ledger.ts'
import { businessWallet, platformFee, userHold, userWallet } from '../money/accounts.ts'
import { computeFee, findPolicy } from '../money/fees.ts'
import { transition } from './requestState.ts'
import type { LedgerEntryInput, LoanStatus, Money, RepaymentType, Tx } from '../types.ts'

export type Loan = typeof loans.$inferSelect
export type LoanShare = typeof loanShares.$inferSelect
export type Repayment = typeof repayments.$inferSelect

const DAY = 86_400_000
const YEAR_DAYS = 365n

/**
 * Simple daily interest: principal × rate × days / 365, floored.
 * One function, used by both the accrual job and the schedule preview, so the
 * number a business is shown up front is the number it will be charged.
 */
export function interestFor({
  principal,
  rateAnnualBps,
  days,
}: {
  principal: Money
  rateAnnualBps: number
  days: number
}): Money {
  return divFloor(principal * BigInt(rateAnnualBps) * BigInt(days), 10000n * YEAR_DAYS)
}

/**
 * Turn a filled request into a loan: every investor's hold is released into the
 * business wallet in ONE transaction, and each share is frozen as `shareBps`
 * with Σ = 10000 exactly (D4 / §6.5). Recomputing shares per payment is the
 * classic way syndicated distribution drifts, so it never happens here.
 */
export async function disburseLoan(
  requestId: string,
): Promise<{ loanId: string; transactionId: string; principal: Money }> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT * FROM funding_requests WHERE id = ${requestId} FOR UPDATE`,
    )
    const raw = (locked.rows ?? locked)[0] as Record<string, any> | undefined
    if (!raw) throw errors.notFound('Заявку')

    const request = {
      id: String(raw.id),
      status: raw.status as string,
      businessId: String(raw.business_id),
      currency: String(raw.currency),
      rateAnnualBps: Number(raw.rate_annual_bps),
      termDays: Number(raw.term_days),
      repaymentType: raw.repayment_type as RepaymentType,
    }
    if (request.status !== 'open') throw errors.requestNotOpen()

    const held = await tx
      .select()
      .from(fundings)
      .where(and(eq(fundings.requestId, requestId), eq(fundings.status, 'held')))
      .orderBy(asc(fundings.createdAt), asc(fundings.id))
    if (!held.length) throw errors.conflict('NOTHING_FUNDED', 'Заявку ніхто не профінансував')

    const principal = held.reduce((acc, f) => acc + f.amount, 0n)
    const currency = request.currency
    const now = new Date()
    const maturesAt = new Date(now.getTime() + request.termDays * DAY)

    const loanId = newId('loan')

    // Origination fee (D3, optional and 0 by default): taken out of what the
    // business receives, in the same transaction — never billed separately.
    const originationPolicy = await findPolicy('origination', currency, now, tx)
    const { fee: origination, policyId: originationPolicyId } = computeFee(
      originationPolicy,
      principal,
    )

    const wallet = await businessWallet(request.businessId, currency, tx)
    const entries: LedgerEntryInput[] = []
    for (const funding of held) {
      const hold = await userHold(funding.investorId, currency, tx)
      entries.push({
        accountId: hold.id,
        currency,
        amount: -funding.amount,
        entryType: 'disbursement',
        relatedLoanId: loanId,
        comment: 'кошти видано бізнесу',
      })
    }
    entries.push({
      accountId: wallet.id,
      currency,
      amount: principal - origination,
      entryType: 'disbursement',
      relatedLoanId: loanId,
      comment: 'отримано за заявкою',
    })
    if (origination > 0n) {
      const feeAccount = await platformFee(currency, tx)
      entries.push({
        accountId: feeAccount.id,
        currency,
        amount: origination,
        entryType: 'fee',
        relatedLoanId: loanId,
        comment: 'комісія за видачу',
      })
    }

    const posted = await postTransaction(
      {
        type: 'disbursement',
        actorId: request.businessId,
        meta: { requestId, loanId, feePolicyId: originationPolicyId },
        entries,
      },
      tx,
    )

    const [loan] = await tx
      .insert(loans)
      .values({
        id: loanId,
        requestId,
        businessId: request.businessId,
        currency,
        principal,
        outstandingPrincipal: principal,
        rateAnnualBps: request.rateAnnualBps,
        termDays: request.termDays,
        repaymentType: request.repaymentType,
        status: 'disbursed',
        disbursedAt: now,
        accruedThrough: now,
        maturesAt,
      })
      .returning()

    // Σ shareBps === 10000, guaranteed by the remainder rule in splitProportionally.
    const shareValues = splitProportionally(
      10000n,
      held.map((f) => f.amount),
    )
    await tx.insert(loanShares).values(
      held.map((funding, index) => ({
        id: newId('shr'),
        loanId,
        investorId: funding.investorId,
        principalShare: funding.amount,
        shareBps: Number(shareValues[index]),
      })),
    )

    await tx
      .update(fundings)
      .set({ status: 'released', closedAt: now })
      .where(and(eq(fundings.requestId, requestId), eq(fundings.status, 'held')))

    await tx.insert(repayments).values(buildSchedule({ loan, now }))

    // draft/open → funded → disbursed, both moves through the state machine.
    const funded = await transition(tx, { id: requestId, status: 'open' }, 'funded', {
      amountFunded: principal,
    })
    await transition(tx, funded, 'disbursed', { closedAt: now })

    await tx.insert(auditLog).values({
      id: newId('aud'),
      actorId: request.businessId,
      action: 'loan.disburse',
      entity: 'loan',
      entityId: loanId,
      data: {
        requestId,
        principal: principal.toString(),
        investors: held.length,
        transactionId: posted.transactionId,
      },
    })

    return { loanId, transactionId: posted.transactionId, principal }
  })
}

/**
 * Schedule generation. `bullet`: interest monthly, principal at maturity.
 * `interest_only_flex`: same interest rhythm, principal repayable on demand —
 * the maturity row still carries it so a due date always exists.
 */
export function buildSchedule({
  loan,
  now = new Date(),
}: {
  loan: Pick<Loan, 'id' | 'principal' | 'rateAnnualBps' | 'termDays'>
  now?: Date
}): Array<typeof repayments.$inferInsert> {
  const rows: Array<typeof repayments.$inferInsert> = []
  const periodDays = 30
  const start = now.getTime()
  const totalDays = loan.termDays
  let seq = 1
  let elapsed = 0

  while (elapsed + periodDays < totalDays) {
    elapsed += periodDays
    rows.push({
      id: newId('rep'),
      loanId: loan.id,
      seq,
      dueAt: new Date(start + elapsed * DAY),
      principalDue: 0n,
      interestDue: interestFor({
        principal: loan.principal,
        rateAnnualBps: loan.rateAnnualBps,
        days: periodDays,
      }),
      status: 'due',
    })
    seq += 1
  }

  // Final instalment: the remaining interest tail plus the whole principal.
  const tailDays = totalDays - elapsed
  rows.push({
    id: newId('rep'),
    loanId: loan.id,
    seq,
    dueAt: new Date(start + totalDays * DAY),
    principalDue: loan.principal,
    interestDue: interestFor({
      principal: loan.principal,
      rateAnnualBps: loan.rateAnnualBps,
      days: tailDays,
    }),
    status: 'due',
  })
  return rows
}

/**
 * Repay. Interest first, then principal (§6.5) — the other order misstates
 * investor yield. The whole distribution is ONE transaction with N+1 entries:
 * if it cannot be posted in full, nothing is posted.
 */
export async function repay({
  loanId,
  userId,
  amount,
  idempotencyKey,
}: {
  loanId: string
  userId: string
  amount: string
  idempotencyKey?: string | null
}): Promise<{
  transactionId: string
  replayed?: boolean
  principal?: Money
  interest?: Money
  fee?: Money
  closed?: boolean
}> {
  const value = parseAmount(amount)
  if (value <= 0n) throw errors.validation('Сума має бути більшою за нуль', { amount: 'мін. 0.01' })

  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`SELECT * FROM loans WHERE id = ${loanId} FOR UPDATE`)
    const raw = (locked.rows ?? locked)[0] as Record<string, any> | undefined
    if (!raw) throw errors.notFound('Позику')

    const loan = {
      id: String(raw.id),
      businessId: String(raw.business_id),
      currency: String(raw.currency),
      status: raw.status as LoanStatus,
      outstandingPrincipal: BigInt(raw.outstanding_principal),
      accruedInterest: BigInt(raw.accrued_interest),
      paidInterest: BigInt(raw.paid_interest),
    }
    if (['closed'].includes(loan.status)) {
      throw errors.conflict('LOAN_CLOSED', 'Позику вже закрито')
    }

    const [business] = await tx
      .select()
      .from(businesses)
      .where(eq(businesses.id, loan.businessId))
      .limit(1)
    if (!business) throw errors.notFound('Бізнес')
    if (business.ownerUserId !== userId) throw errors.forbidden('Це не ваша позика')

    const interestOutstanding = loan.accruedInterest - loan.paidInterest
    const payInterest = minOf(value, interestOutstanding > 0n ? interestOutstanding : 0n)
    const payPrincipal = minOf(value - payInterest, loan.outstandingPrincipal)
    const total = payInterest + payPrincipal
    if (total <= 0n) throw errors.validation('Нічого сплачувати', { amount: 'заборгованості немає' })
    if (total < value) {
      throw errors.validation('Сума перевищує заборгованість', {
        amount: `максимум ${total} мінорних одиниць`,
      })
    }

    const shares = await tx
      .select()
      .from(loanShares)
      .where(eq(loanShares.loanId, loanId))
      .orderBy(asc(loanShares.id))
    if (!shares.length) throw errors.conflict('NO_SHARES', 'У позики немає інвесторів')

    const weights = shares.map((s) => s.shareBps)
    const principalParts = splitProportionally(payPrincipal, weights)
    const interestParts = splitProportionally(payInterest, weights)

    // Platform's cut of investor interest (D3). Rounded up, per investor, so
    // the platform never loses a kopiyka to rounding and the entries still sum
    // to exactly what the business paid.
    const feePolicy = await findPolicy('interest_share', loan.currency, new Date(), tx)
    const feeParts = interestParts.map((interest) => computeFee(feePolicy, interest).fee)

    const wallet = await businessWallet(loan.businessId, loan.currency, tx)
    const entries: LedgerEntryInput[] = [
      {
        accountId: wallet.id,
        currency: loan.currency,
        amount: -total,
        entryType: 'repayment_out',
        relatedLoanId: loanId,
        comment: 'погашення позики',
      },
    ]
    for (const [index, share] of shares.entries()) {
      const payout = principalParts[index]! + interestParts[index]! - feeParts[index]!
      if (payout === 0n) continue
      const investorWallet = await userWallet(share.investorId, loan.currency, tx)
      entries.push({
        accountId: investorWallet.id,
        currency: loan.currency,
        amount: payout,
        entryType: 'repayment_in',
        relatedLoanId: loanId,
        counterpartyId: business.ownerUserId,
        comment: 'надходження за позикою',
      })
    }
    const totalFee = feeParts.reduce((acc, f) => acc + f, 0n)
    if (totalFee > 0n) {
      const feeAccount = await platformFee(loan.currency, tx)
      entries.push({
        accountId: feeAccount.id,
        currency: loan.currency,
        amount: totalFee,
        entryType: 'fee',
        relatedLoanId: loanId,
        comment: 'комісія з відсоткового доходу',
      })
    }

    const posted = await postTransaction(
      {
        type: 'repayment',
        idempotencyKey,
        actorId: userId,
        meta: { loanId, principal: payPrincipal.toString(), interest: payInterest.toString() },
        entries,
      },
      tx,
    )
    if (posted.replayed) return { transactionId: posted.transactionId, replayed: true }

    const outstanding = loan.outstandingPrincipal - payPrincipal
    const paidInterest = loan.paidInterest + payInterest
    const closed = outstanding === 0n && paidInterest >= loan.accruedInterest
    await tx
      .update(loans)
      .set({
        outstandingPrincipal: outstanding,
        paidInterest,
        status: closed ? 'closed' : 'repaying',
        closedAt: closed ? new Date() : null,
      })
      .where(eq(loans.id, loanId))

    const touched = await applyToSchedule(tx, loanId, { payPrincipal, payInterest })
    for (const repaymentId of touched) {
      await tx.insert(repaymentSplits).values(
        shares.map((share, index) => ({
          id: newId('spl'),
          repaymentId,
          investorId: share.investorId,
          principal: principalParts[index]!,
          interest: interestParts[index]!,
          fee: feeParts[index]!,
          transactionId: posted.transactionId,
        })),
      )
    }

    return {
      transactionId: posted.transactionId,
      principal: payPrincipal,
      interest: payInterest,
      fee: totalFee,
      closed,
    }
  })
}

/** Applies a payment to the oldest open instalments first. */
async function applyToSchedule(
  tx: Tx,
  loanId: string,
  { payPrincipal, payInterest }: { payPrincipal: Money; payInterest: Money },
): Promise<string[]> {
  const open = await tx
    .select()
    .from(repayments)
    .where(and(eq(repayments.loanId, loanId), sql`${repayments.status} <> 'paid'`))
    .orderBy(asc(repayments.dueAt), asc(repayments.seq))

  let principalLeft = payPrincipal
  let interestLeft = payInterest
  const touched: string[] = []

  for (const row of open) {
    if (principalLeft === 0n && interestLeft === 0n) break
    const interestPart = minOf(interestLeft, row.interestDue - row.interestPaid)
    const principalPart = minOf(principalLeft, row.principalDue - row.principalPaid)
    if (interestPart === 0n && principalPart === 0n) continue

    const interestPaid = row.interestPaid + interestPart
    const principalPaid = row.principalPaid + principalPart
    const settled = interestPaid >= row.interestDue && principalPaid >= row.principalDue

    await tx
      .update(repayments)
      .set({
        interestPaid,
        principalPaid,
        status: settled ? 'paid' : row.status === 'overdue' ? 'overdue' : 'due',
        paidAt: settled ? new Date() : row.paidAt,
      })
      .where(eq(repayments.id, row.id))

    interestLeft -= interestPart
    principalLeft -= principalPart
    touched.push(row.id)
  }

  // Early repayment beyond the schedule still counts — it is recorded against
  // the last instalment rather than silently dropped.
  if ((principalLeft > 0n || interestLeft > 0n) && open.length) {
    touched.push(open.at(-1)!.id)
  }
  return [...new Set(touched)]
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function listLoans({
  userId,
  role,
  status,
}: {
  userId: string
  role?: 'borrower' | 'investor'
  status?: string
}) {
  if (role === 'borrower') {
    const [business] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.ownerUserId, userId))
      .limit(1)
    if (!business) return { items: [] }
    const conditions = [eq(loans.businessId, business.id)]
    if (status) conditions.push(eq(loans.status, status as LoanStatus))
    const rows = await db
      .select()
      .from(loans)
      .where(and(...conditions))
      .orderBy(desc(loans.disbursedAt))
    return { items: await Promise.all(rows.map((loan) => decorate(loan, { viewerId: userId }))) }
  }

  // Investor view: loans this user holds a share in.
  const rows = await db
    .select({ loan: loans, share: loanShares })
    .from(loanShares)
    .innerJoin(loans, eq(loans.id, loanShares.loanId))
    .where(eq(loanShares.investorId, userId))
    .orderBy(desc(loans.disbursedAt))
  return {
    items: await Promise.all(
      rows
        .filter((r) => !status || r.loan.status === status)
        .map((r) => decorate(r.loan, { viewerId: userId, share: r.share })),
    ),
  }
}

export async function getLoan(loanId: string, viewerId: string) {
  const [loan] = await db.select().from(loans).where(eq(loans.id, loanId)).limit(1)
  if (!loan) throw errors.notFound('Позику')

  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, loan.businessId))
    .limit(1)
  const [share] = await db
    .select()
    .from(loanShares)
    .where(and(eq(loanShares.loanId, loanId), eq(loanShares.investorId, viewerId)))
    .limit(1)

  // Visible to the borrower and to any investor in the syndicate — nobody else.
  if (!business || (business.ownerUserId !== viewerId && !share)) throw errors.notFound('Позику')

  const schedule = await db
    .select()
    .from(repayments)
    .where(eq(repayments.loanId, loanId))
    .orderBy(asc(repayments.seq))

  const investors = await db
    .select({
      investorId: loanShares.investorId,
      name: users.displayName,
      shareBps: loanShares.shareBps,
      principalShare: loanShares.principalShare,
    })
    .from(loanShares)
    .innerJoin(users, eq(users.id, loanShares.investorId))
    .where(eq(loanShares.loanId, loanId))

  return {
    ...(await decorate(loan, { viewerId, share })),
    business: { id: business.id, name: business.name },
    schedule,
    investors,
  }
}

async function decorate(
  loan: Loan,
  { viewerId, share }: { viewerId?: string; share?: LoanShare | null } = {},
) {
  const [next] = await db
    .select()
    .from(repayments)
    .where(and(eq(repayments.loanId, loan.id), sql`${repayments.status} <> 'paid'`))
    .orderBy(asc(repayments.dueAt))
    .limit(1)

  let myShare: LoanShare | null = share ?? null
  if (!myShare && viewerId) {
    const [row] = await db
      .select()
      .from(loanShares)
      .where(and(eq(loanShares.loanId, loan.id), eq(loanShares.investorId, viewerId)))
      .limit(1)
    myShare = row ?? null
  }

  return {
    ...loan,
    interestOutstanding: loan.accruedInterest - loan.paidInterest,
    nextPayment: next ?? null,
    myShareBps: myShare?.shareBps ?? null,
    myPrincipalShare: myShare?.principalShare ?? null,
  }
}

/**
 * Daily accrual (§6.4). Interest is a claim, not cash, so it accumulates on the
 * loan rather than in the ledger — cash entries appear when it is actually
 * paid. `accruedThrough` advances by whole days only, so running the job twice
 * in one day cannot double-charge.
 */
export async function accrueInterest(
  now: Date = new Date(),
  log: Partial<Console> = console,
): Promise<{ touched: number; overdue: number }> {
  const active = await db
    .select()
    .from(loans)
    .where(sql`${loans.status} IN ('disbursed', 'repaying', 'overdue')`)

  let touched = 0
  for (const loan of active) {
    const from = new Date(loan.accruedThrough ?? loan.disbursedAt)
    const days = Math.floor((now.getTime() - from.getTime()) / DAY)
    if (days <= 0) continue

    const interest = interestFor({
      principal: loan.outstandingPrincipal,
      rateAnnualBps: loan.rateAnnualBps,
      days,
    })
    await db
      .update(loans)
      .set({
        accruedInterest: loan.accruedInterest + interest,
        accruedThrough: new Date(from.getTime() + days * DAY),
      })
      .where(eq(loans.id, loan.id))
    touched += 1
  }

  // D2: overdue is flagged and visible, with no penalty attached yet.
  const overdue = await db
    .update(repayments)
    .set({ status: 'overdue' })
    .where(and(eq(repayments.status, 'due'), sql`${repayments.dueAt} < now()`))
    .returning({ id: repayments.id, loanId: repayments.loanId })

  if (overdue.length) {
    const ids = [...new Set(overdue.map((r) => r.loanId))]
    await db
      .update(loans)
      .set({ status: 'overdue' })
      .where(
        sql`${loans.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
            AND ${loans.status} IN ('disbursed', 'repaying')`,
      )
  }

  log.info?.({ loans: touched, overdue: overdue.length }, 'accrual: done')
  return { touched, overdue: overdue.length }
}
