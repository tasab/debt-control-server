import { and, eq, sql } from 'drizzle-orm'
import { accounts, accountBalances, currencies } from '../../db/schema/index.js'
import { db } from '../db/index.js'

/**
 * Wallet view for a user: available (spendable) vs held (escrowed in funding
 * offers). Currencies with no account yet still appear at zero, so a new user
 * sees the full list rather than an empty screen.
 */
export async function walletsForUser(userId, tx = db) {
  const rows = await tx
    .select({
      currency: accounts.currency,
      kind: accounts.kind,
      balance: sql`COALESCE(${accountBalances.balance}, 0)`,
    })
    .from(accounts)
    .leftJoin(accountBalances, eq(accountBalances.accountId, accounts.id))
    .where(and(eq(accounts.ownerType, 'user'), eq(accounts.ownerId, userId)))

  const active = await tx
    .select()
    .from(currencies)
    .where(eq(currencies.isActive, true))
    .orderBy(currencies.sortOrder)

  const byCurrency = new Map(
    active.map((c) => [c.code, { currency: c.code, available: 0n, held: 0n }]),
  )
  for (const row of rows) {
    const entry = byCurrency.get(row.currency) ?? {
      currency: row.currency,
      available: 0n,
      held: 0n,
    }
    if (row.kind === 'user_wallet') entry.available += BigInt(row.balance)
    if (row.kind === 'user_hold') entry.held += BigInt(row.balance)
    byCurrency.set(row.currency, entry)
  }

  return [...byCurrency.values()].map((w) => ({ ...w, total: w.available + w.held }))
}

/** Balance of one account, from the materialised table. */
export async function balanceOf(accountId, tx = db) {
  const [row] = await tx
    .select({ balance: accountBalances.balance })
    .from(accountBalances)
    .where(eq(accountBalances.accountId, accountId))
    .limit(1)
  return row?.balance ?? 0n
}

/** Available (non-held) balance of a user's wallet in one currency. */
export async function availableBalance(userId, currency, tx = db) {
  const [row] = await tx
    .select({ balance: sql`COALESCE(${accountBalances.balance}, 0)` })
    .from(accounts)
    .leftJoin(accountBalances, eq(accountBalances.accountId, accounts.id))
    .where(
      and(
        eq(accounts.ownerType, 'user'),
        eq(accounts.ownerId, userId),
        eq(accounts.kind, 'user_wallet'),
        eq(accounts.currency, currency),
      ),
    )
    .limit(1)
  return BigInt(row?.balance ?? 0)
}

/** All balances of a business: wallets and registers, split by kind. */
export async function businessBalances(businessId, tx = db) {
  const rows = await tx
    .select({
      accountId: accounts.id,
      kind: accounts.kind,
      currency: accounts.currency,
      name: accounts.name,
      balance: sql`COALESCE(${accountBalances.balance}, 0)`,
    })
    .from(accounts)
    .leftJoin(accountBalances, eq(accountBalances.accountId, accounts.id))
    .where(and(eq(accounts.ownerType, 'business'), eq(accounts.ownerId, businessId)))

  return rows.map((r) => ({ ...r, balance: BigInt(r.balance) }))
}
