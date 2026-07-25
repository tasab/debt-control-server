import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.ts'
import {
  accounts,
  balanceSnapshots,
  businesses,
  ledgerEntries,
  loanShares,
  loans,
  repaymentSplits,
} from '../../db/schema/index.ts'
import { walletsForUser } from '../money/balances.ts'
import { valuationTable } from '../money/valuation.ts'
import { divFloor } from '../money/amount.ts'
import type { Money } from '../types.ts'

interface HistoryPoint {
  date: string
  totalBase: Money
  kinds: Record<string, Money>
  currencies: Record<string, Money>
}

/** YYYY-MM-DD in UTC — the key balance_snapshots is written under. */
export const dayKey = (date: Date | string = new Date()): string => new Date(date).toISOString().slice(0, 10)

/**
 * Balance chart. Reads the nightly snapshots (§7) rather than aggregating the
 * ledger, so a year of history is one indexed range scan.
 */
export async function balanceHistory({
  userId,
  from,
  to,
  currency,
}: {
  userId: string
  from?: string
  to?: string
  currency?: string
}): Promise<HistoryPoint[]> {
  const conditions = [eq(balanceSnapshots.userId, userId)]
  if (from) conditions.push(sql`${balanceSnapshots.date} >= ${dayKey(from)}`)
  if (to) conditions.push(sql`${balanceSnapshots.date} <= ${dayKey(to)}`)
  if (currency) conditions.push(eq(balanceSnapshots.currency, currency))

  const rows = await db
    .select()
    .from(balanceSnapshots)
    .where(and(...conditions))
    .orderBy(balanceSnapshots.date)

  // Shape it as one point per day: totals in the base currency plus the
  // per-currency and per-kind breakdown the UI switches between.
  const byDate = new Map<string, HistoryPoint>()
  for (const row of rows) {
    const point = byDate.get(row.date) ?? { date: row.date, totalBase: 0n, kinds: {}, currencies: {} }
    point.totalBase += row.amountBase
    point.kinds[row.kind] = (point.kinds[row.kind] ?? 0n) + row.amountBase
    point.currencies[row.currency] = (point.currencies[row.currency] ?? 0n) + row.amount
    byDate.set(row.date, point)
  }
  return [...byDate.values()]
}

/** Headline numbers: what the user holds, has lent out, and owes. */
export async function summary(userId: string) {
  const { toBase, base } = await valuationTable()
  const wallets = await walletsForUser(userId)

  let walletBase = 0n
  let heldBase = 0n
  for (const wallet of wallets) {
    walletBase += toBase(wallet.available, wallet.currency)
    heldBase += toBase(wallet.held, wallet.currency)
  }

  // Lent out: this investor's share of every active loan's outstanding principal.
  const investorRows = await db
    .select({ loan: loans, share: loanShares })
    .from(loanShares)
    .innerJoin(loans, eq(loans.id, loanShares.loanId))
    .where(eq(loanShares.investorId, userId))

  let lentBase = 0n
  let accruedBase = 0n
  let overdueBase = 0n
  for (const { loan, share } of investorRows) {
    if (['closed'].includes(loan.status)) continue
    const myPrincipal = divFloor(loan.outstandingPrincipal * BigInt(share.shareBps), 10000n)
    const myInterest = divFloor(
      (loan.accruedInterest - loan.paidInterest) * BigInt(share.shareBps),
      10000n,
    )
    lentBase += toBase(myPrincipal, loan.currency)
    accruedBase += toBase(myInterest, loan.currency)
    if (loan.status === 'overdue') overdueBase += toBase(myPrincipal, loan.currency)
  }

  // Borrowed: outstanding debt of this user's business, if any.
  let borrowedBase = 0n
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.ownerUserId, userId))
    .limit(1)
  if (business) {
    const borrowerLoans = await db
      .select()
      .from(loans)
      .where(
        and(eq(loans.businessId, business.id), sql`${loans.status} <> 'closed'`),
      )
    for (const loan of borrowerLoans) {
      borrowedBase += toBase(
        loan.outstandingPrincipal + (loan.accruedInterest - loan.paidInterest),
        loan.currency,
      )
    }
  }

  return {
    baseCurrency: base,
    wallets: walletBase,
    held: heldBase,
    lent: lentBase,
    accrued: accruedBase,
    overdue: overdueBase,
    borrowed: borrowedBase,
    netWorth: walletBase + heldBase + lentBase + accruedBase - borrowedBase,
  }
}

/**
 * Investor portfolio. Return is reported as a simple realised yield —
 * interest received net of fees over principal deployed, annualised — and
 * labelled as such. A full XIRR needs a dated cash-flow series per position;
 * quoting one here without it would be a number nobody could reproduce.
 */
export async function portfolio(userId: string) {
  const { toBase, base } = await valuationTable()

  const positions = await db
    .select({ loan: loans, share: loanShares, business: businesses })
    .from(loanShares)
    .innerJoin(loans, eq(loans.id, loanShares.loanId))
    .innerJoin(businesses, eq(businesses.id, loans.businessId))
    .where(eq(loanShares.investorId, userId))

  const [received] = await db
    .select({
      interest: sql`COALESCE(SUM(${repaymentSplits.interest}), 0)`,
      fee: sql`COALESCE(SUM(${repaymentSplits.fee}), 0)`,
      principal: sql`COALESCE(SUM(${repaymentSplits.principal}), 0)`,
    })
    .from(repaymentSplits)
    .where(eq(repaymentSplits.investorId, userId))

  let activeBase = 0n
  let deployedBase = 0n
  let weightedRate = 0n
  const byBusiness = new Map<string, { id: string; name: string; amount: Money }>()

  for (const { loan, share, business } of positions) {
    const myPrincipal = divFloor(loan.outstandingPrincipal * BigInt(share.shareBps), 10000n)
    const principalBase = toBase(myPrincipal, loan.currency)
    deployedBase += toBase(share.principalShare, loan.currency)
    if (loan.status !== 'closed') {
      activeBase += principalBase
      weightedRate += principalBase * BigInt(loan.rateAnnualBps)
      const row = byBusiness.get(business.id) ?? { id: business.id, name: business.name, amount: 0n }
      row.amount += principalBase
      byBusiness.set(business.id, row)
    }
  }

  const distribution = [...byBusiness.values()]
    .map((row) => ({
      ...row,
      shareBps: activeBase > 0n ? Number((row.amount * 10000n) / activeBase) : 0,
    }))
    .sort((a, b) => b.shareBps - a.shareBps)

  // §11: concentration is warned about, not blocked — the investor decides.
  const concentration = distribution.find((row) => row.shareBps > 5000) ?? null

  const totals = received as { interest: string; fee: string; principal: string }
  const interestNet = BigInt(totals.interest) - BigInt(totals.fee)
  return {
    baseCurrency: base,
    activePrincipal: activeBase,
    totalDeployed: deployedBase,
    interestReceived: BigInt(totals.interest),
    feesPaid: BigInt(totals.fee),
    principalReturned: BigInt(totals.principal),
    netInterest: interestNet,
    weightedRateBps: activeBase > 0n ? Number(weightedRate / activeBase) : 0,
    positionCount: positions.filter((p) => p.loan.status !== 'closed').length,
    defaultedCount: positions.filter((p) => p.loan.status === 'defaulted').length,
    overdueCount: positions.filter((p) => p.loan.status === 'overdue').length,
    distribution,
    concentrationWarning: concentration
      ? { businessId: concentration.id, name: concentration.name, shareBps: concentration.shareBps }
      : null,
  }
}

/**
 * Nightly snapshot writer. Idempotent per (user, date): re-running overwrites
 * the same rows rather than doubling them.
 */
export async function writeSnapshots(
  date: Date = new Date(),
  log: Partial<Console> = console,
): Promise<number> {
  const { toBase } = await valuationTable()
  const key = dayKey(date)

  const userIds = await db
    .selectDistinct({ id: accounts.ownerId })
    .from(accounts)
    .where(eq(accounts.ownerType, 'user'))

  let written = 0
  for (const { id: userId } of userIds) {
    const wallets = await walletsForUser(userId)
    const rows: Array<{ currency: string; kind: string; amount: Money }> = []
    for (const wallet of wallets) {
      if (wallet.available !== 0n) {
        rows.push({ currency: wallet.currency, kind: 'wallet', amount: wallet.available })
      }
      if (wallet.held !== 0n) {
        rows.push({ currency: wallet.currency, kind: 'held', amount: wallet.held })
      }
    }

    const lent = await db
      .select({ loan: loans, share: loanShares })
      .from(loanShares)
      .innerJoin(loans, eq(loans.id, loanShares.loanId))
      .where(and(eq(loanShares.investorId, userId), sql`${loans.status} <> 'closed'`))
    const lentByCurrency = new Map<string, Money>()
    for (const { loan, share } of lent) {
      const mine = divFloor(loan.outstandingPrincipal * BigInt(share.shareBps), 10000n)
      lentByCurrency.set(loan.currency, (lentByCurrency.get(loan.currency) ?? 0n) + mine)
    }
    for (const [currency, amount] of lentByCurrency) {
      if (amount !== 0n) rows.push({ currency, kind: 'lent', amount })
    }

    for (const row of rows) {
      await db
        .insert(balanceSnapshots)
        .values({
          userId,
          date: key,
          currency: row.currency,
          kind: row.kind,
          amount: row.amount,
          amountBase: toBase(row.amount, row.currency),
        })
        .onConflictDoUpdate({
          target: [
            balanceSnapshots.userId,
            balanceSnapshots.date,
            balanceSnapshots.currency,
            balanceSnapshots.kind,
          ],
          set: { amount: row.amount, amountBase: toBase(row.amount, row.currency) },
        })
      written += 1
    }
  }

  log.info?.({ date: key, rows: written }, 'snapshots: written')
  return written
}

/** CSV export of the transaction history (§7). */
export async function exportCsv(userId: string): Promise<string> {
  const rows = await db
    .select({
      createdAt: ledgerEntries.createdAt,
      type: ledgerEntries.entryType,
      currency: ledgerEntries.currency,
      amount: ledgerEntries.amount,
      comment: ledgerEntries.comment,
    })
    .from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .where(and(eq(accounts.ownerType, 'user'), eq(accounts.ownerId, userId)))
    .orderBy(ledgerEntries.createdAt)

  const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
  const lines = ['date,type,currency,amount,comment']
  for (const row of rows) {
    lines.push(
      [
        row.createdAt.toISOString(),
        row.type,
        row.currency,
        row.amount.toString(),
        escape(row.comment),
      ].join(','),
    )
  }
  return lines.join('\n')
}
