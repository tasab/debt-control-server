import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  accounts,
  accountBalances,
  businesses,
  loans,
  registers,
  startingCapital,
  users,
} from '../../db/schema/index.js'
import { errors } from '../errors.js'
import { newId, parseAmount } from '../money/amount.js'
import { businessBalances } from '../money/balances.js'
import { postTransaction } from '../money/ledger.js'
import { businessWallet, userWallet } from '../money/accounts.js'
import { valuationTable } from '../money/valuation.js'
import { scoreBusiness } from './scoring.js'

export async function createBusiness({ userId, name, description, baseCurrency, startingCapital: capital }) {
  const [existing] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.ownerUserId, userId))
    .limit(1)
  if (existing) throw errors.conflict('BUSINESS_EXISTS', 'Бізнес-профіль уже створено')

  return db.transaction(async (tx) => {
    const [business] = await tx
      .insert(businesses)
      .values({
        id: newId('biz'),
        ownerUserId: userId,
        name: name.trim(),
        description: description ?? null,
        baseCurrency,
      })
      .returning()

    // Starting capital is a dated setting, not a mutable field: the P&L
    // baseline must stay reproducible for any past date (PLATFORM_PLAN §5).
    if (capital) {
      await tx.insert(startingCapital).values({
        id: newId('cap'),
        businessId: business.id,
        amount: parseAmount(capital.amount, { field: 'startingCapital.amount' }),
        currency: capital.currency,
      })
    }
    return business
  })
}

export async function businessOf(userId) {
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.ownerUserId, userId))
    .limit(1)
  if (!business) throw errors.notFound('Бізнес-профіль')
  return business
}

/** Public profile — what an investor sees on a funding request. */
export async function publicProfile(businessId) {
  const [business] = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      description: businesses.description,
      baseCurrency: businesses.baseCurrency,
      isVerified: businesses.isVerified,
      createdAt: businesses.createdAt,
      ownerName: users.displayName,
    })
    .from(businesses)
    .innerJoin(users, eq(users.id, businesses.ownerUserId))
    .where(eq(businesses.id, businessId))
    .limit(1)
  if (!business) throw errors.notFound('Бізнес')

  const rating = await scoreBusiness({ ...business, createdAt: business.createdAt })
  const history = await db
    .select({
      total: sql`COUNT(*)`,
      closed: sql`COUNT(*) FILTER (WHERE ${loans.status} = 'closed')`,
    })
    .from(loans)
    .where(eq(loans.businessId, businessId))

  return {
    ...business,
    rating,
    loansTotal: Number(history[0]?.total ?? 0),
    loansClosed: Number(history[0]?.closed ?? 0),
  }
}

export async function setStartingCapital(businessId, { amount, currency }) {
  const [row] = await db
    .insert(startingCapital)
    .values({
      id: newId('cap'),
      businessId,
      amount: parseAmount(amount),
      currency,
    })
    .returning()
  return row
}

export async function currentStartingCapital(businessId, tx = db) {
  const [row] = await tx
    .select()
    .from(startingCapital)
    .where(
      and(
        eq(startingCapital.businessId, businessId),
        sql`${startingCapital.effectiveFrom} <= now()`,
      ),
    )
    .orderBy(sql`${startingCapital.effectiveFrom} DESC`)
    .limit(1)
  return row ?? null
}

// ─── Registers (каси) ───────────────────────────────────────────────────────

export async function listRegisters(businessId) {
  const rows = await db
    .select({
      id: registers.id,
      name: registers.name,
      currency: registers.currency,
      isActive: registers.isActive,
      accountId: registers.accountId,
      balance: sql`COALESCE(${accountBalances.balance}, 0)`,
    })
    .from(registers)
    .leftJoin(accountBalances, eq(accountBalances.accountId, registers.accountId))
    .where(and(eq(registers.businessId, businessId), isNull(registers.deletedAt)))
    .orderBy(registers.createdAt)
  return rows.map((r) => ({ ...r, balance: BigInt(r.balance) }))
}

export async function createRegister(businessId, { name, currency }) {
  return db.transaction(async (tx) => {
    const accountId = newId('acc')
    await tx.insert(accounts).values({
      id: accountId,
      ownerType: 'business',
      ownerId: businessId,
      kind: 'business_register',
      currency,
      name,
    })
    await tx.insert(accountBalances).values({ accountId })
    const [register] = await tx
      .insert(registers)
      .values({ id: newId('reg'), businessId, accountId, name: name.trim(), currency })
      .returning()
    return register
  })
}

export async function updateRegister(businessId, registerId, patch) {
  const [row] = await db
    .update(registers)
    .set({ name: patch.name, isActive: patch.isActive })
    .where(and(eq(registers.id, registerId), eq(registers.businessId, businessId)))
    .returning()
  if (!row) throw errors.notFound('Касу')
  await db.update(accounts).set({ name: row.name }).where(eq(accounts.id, row.accountId))
  return row
}

/** Soft delete only — nothing financial is ever removed (PLATFORM_PLAN §8). */
export async function deleteRegister(businessId, registerId) {
  const [row] = await db
    .select()
    .from(registers)
    .where(and(eq(registers.id, registerId), eq(registers.businessId, businessId)))
    .limit(1)
  if (!row) throw errors.notFound('Касу')

  const [balance] = await db
    .select({ balance: accountBalances.balance })
    .from(accountBalances)
    .where(eq(accountBalances.accountId, row.accountId))
  if ((balance?.balance ?? 0n) !== 0n) {
    throw errors.conflict('REGISTER_NOT_EMPTY', 'Спершу перекажіть залишок каси', {
      register: 'каса не порожня',
    })
  }

  await db
    .update(registers)
    .set({ deletedAt: new Date(), isActive: false })
    .where(eq(registers.id, registerId))
  await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, row.accountId))
  return { ok: true }
}

// ─── Internal money movement ────────────────────────────────────────────────

/**
 * Move money between the owner's personal wallet, the business wallet and its
 * registers. Cash in a каса is an account like any other (§5), so "put 5000 UAH
 * into register 1" is an ordinary two-entry transaction, not a special case.
 *
 * Endpoints are `owner`, `business`, or `register:<id>`.
 */
export async function moveInternal({
  userId,
  businessId,
  from,
  to,
  currency,
  amount,
  comment,
  idempotencyKey,
}) {
  const value = parseAmount(amount)
  if (value <= 0n) throw errors.validation('Сума має бути більшою за нуль', { amount: 'мін. 0.01' })
  if (from === to) throw errors.validation('Оберіть різні рахунки', { to: 'той самий рахунок' })

  return db.transaction(async (tx) => {
    const resolve = async (endpoint) => {
      if (endpoint === 'owner') return userWallet(userId, currency, tx)
      if (endpoint === 'business') return businessWallet(businessId, currency, tx)
      if (endpoint.startsWith('register:')) {
        const registerId = endpoint.slice('register:'.length)
        const [row] = await tx
          .select()
          .from(registers)
          .where(and(eq(registers.id, registerId), eq(registers.businessId, businessId)))
          .limit(1)
        if (!row) throw errors.notFound('Касу')
        if (row.currency !== currency) {
          throw errors.validation('Валюта каси не збігається', {
            currency: `каса в ${row.currency}`,
          })
        }
        return { id: row.accountId }
      }
      throw errors.validation('Невідомий рахунок', { from: endpoint })
    }

    const source = await resolve(from)
    const target = await resolve(to)

    return postTransaction(
      {
        type: 'internal_transfer',
        idempotencyKey,
        actorId: userId,
        meta: { businessId, from, to },
        entries: [
          { accountId: source.id, currency, amount: -value, entryType: 'internal_out', comment },
          { accountId: target.id, currency, amount: value, entryType: 'internal_in', comment },
        ],
      },
      tx,
    )
  })
}

// ─── Dashboard (PLATFORM_PLAN §5 + Appendix A) ──────────────────────────────

/**
 * The old client-side engine.js, moved server-side and fed from the ledger
 * instead of hand-typed snapshots. Everything is valued in the base currency at
 * the mid rate, and — unlike the spreadsheet this inherits from — conversion is
 * always applied to the *total* per currency, from one function.
 */
export async function dashboard(businessId) {
  const [business] = await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1)
  if (!business) throw errors.notFound('Бізнес')

  const { toBase, base, staleCodes } = await valuationTable()
  const balances = await businessBalances(businessId)

  const byCurrency = new Map()
  const bump = (currency, key, value) => {
    const row = byCurrency.get(currency) ?? { currency, wallets: 0n, registers: 0n, debt: 0n }
    row[key] += value
    byCurrency.set(currency, row)
  }

  for (const account of balances) {
    if (account.kind === 'user_wallet') bump(account.currency, 'wallets', account.balance)
    if (account.kind === 'business_register') bump(account.currency, 'registers', account.balance)
  }

  const activeLoans = await db
    .select()
    .from(loans)
    .where(
      and(
        eq(loans.businessId, businessId),
        sql`${loans.status} IN ('disbursed', 'repaying', 'overdue')`,
      ),
    )
  for (const loan of activeLoans) {
    bump(loan.currency, 'debt', loan.outstandingPrincipal + (loan.accruedInterest - loan.paidInterest))
  }

  const currencyRows = [...byCurrency.values()].map((row) => ({
    ...row,
    walletsBase: toBase(row.wallets, row.currency),
    registersBase: toBase(row.registers, row.currency),
    debtBase: toBase(row.debt, row.currency),
  }))

  const assets = currencyRows.reduce((acc, r) => acc + r.walletsBase + r.registersBase, 0n)
  const liabilities = currencyRows.reduce((acc, r) => acc + r.debtBase, 0n)
  const netWorth = assets - liabilities

  const capital = await currentStartingCapital(businessId)
  const startingBase = capital ? toBase(capital.amount, capital.currency) : 0n
  const profit = netWorth - startingBase

  // Cost of capital: rate weighted by outstanding principal, valued in base so
  // loans in different currencies are comparable.
  let weighted = 0n
  let weight = 0n
  for (const loan of activeLoans) {
    const principalBase = toBase(loan.outstandingPrincipal, loan.currency)
    weighted += principalBase * BigInt(loan.rateAnnualBps)
    weight += principalBase
  }
  const costOfCapitalBps = weight > 0n ? Number(weighted / weight) : 0

  return {
    business,
    baseCurrency: base,
    assets,
    liabilities,
    netWorth,
    startingCapital: capital
      ? { amount: capital.amount, currency: capital.currency, base: startingBase }
      : null,
    profit,
    costOfCapitalBps,
    activeLoanCount: activeLoans.length,
    byCurrency: currencyRows,
    staleCodes,
  }
}
