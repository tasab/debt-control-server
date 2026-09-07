import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { accounts, ledgerEntries, transactions, users } from '../../db/schema/index.ts'
import { errors } from '../errors.ts'
import { decodeCursor, encodeCursor, iso, money } from '../serialize.ts'
import type { Money } from '../types.ts'

export interface HistoryQuery {
  limit?: number
  cursor?: string
  currency?: string
  type?: string
  from?: string
  to?: string
  search?: string
}

interface EntryRow {
  id: string
  transactionId: string
  entryType: string | null
  currency: string
  amount: Money
  comment: string | null
  counterpartyId: string | null
  createdAt: Date
  accountKind: string
}

type Counterparties = Map<string, { id: string; name: string }>

/**
 * History is read from the user's own ledger entries: one row per movement,
 * already signed from that user's point of view. No aggregation, no joins onto
 * the counterparty's side — an entry is what happened to *this* account.
 */
export async function listTransactions(userId: string, query: HistoryQuery = {}) {
  const { limit = 50, cursor, currency, type, from, to, search } = query
  const cursorValue = decodeCursor(cursor)

  const conditions = [
    eq(accounts.ownerType, 'user'),
    eq(accounts.ownerId, userId),
    sql`${accounts.kind} IN ('user_wallet', 'user_hold')`,
  ]
  if (currency) conditions.push(eq(ledgerEntries.currency, currency))
  if (type) conditions.push(eq(ledgerEntries.entryType, type))
  if (from) conditions.push(sql`${ledgerEntries.createdAt} >= ${new Date(from)}`)
  if (to) conditions.push(sql`${ledgerEntries.createdAt} <= ${new Date(to)}`)
  if (search) conditions.push(sql`${ledgerEntries.comment} ILIKE ${`%${search}%`}`)
  if (cursorValue) {
    conditions.push(
      sql`(${ledgerEntries.createdAt}, ${ledgerEntries.id}) < (${new Date(cursorValue.createdAt)}, ${cursorValue.id})`,
    )
  }

  const rows = await db
    .select({
      id: ledgerEntries.id,
      transactionId: ledgerEntries.transactionId,
      entryType: ledgerEntries.entryType,
      currency: ledgerEntries.currency,
      amount: ledgerEntries.amount,
      comment: ledgerEntries.comment,
      counterpartyId: ledgerEntries.counterpartyId,
      createdAt: ledgerEntries.createdAt,
      accountKind: accounts.kind,
    })
    .from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .where(and(...conditions))
    .orderBy(sql`${ledgerEntries.createdAt} DESC, ${ledgerEntries.id} DESC`)
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const counterparties = await loadCounterparties(page)

  return {
    items: page.map((row) => serializeEntry(row, counterparties)),
    nextCursor: nextCursorFrom(rows.length > limit ? page.at(-1) : undefined),
  }
}

const nextCursorFrom = (row?: { createdAt: Date; id: string }) =>
  row ? encodeCursor({ createdAt: row.createdAt, id: row.id }) : null

export async function getTransaction(userId: string, transactionId: string) {
  const rows = await db
    .select({
      id: ledgerEntries.id,
      transactionId: ledgerEntries.transactionId,
      entryType: ledgerEntries.entryType,
      currency: ledgerEntries.currency,
      amount: ledgerEntries.amount,
      comment: ledgerEntries.comment,
      counterpartyId: ledgerEntries.counterpartyId,
      createdAt: ledgerEntries.createdAt,
      accountKind: accounts.kind,
      txType: transactions.type,
      txMeta: transactions.meta,
    })
    .from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .innerJoin(transactions, eq(transactions.id, ledgerEntries.transactionId))
    .where(
      and(
        eq(ledgerEntries.transactionId, transactionId),
        eq(accounts.ownerType, 'user'),
        eq(accounts.ownerId, userId),
      ),
    )

  // A user may only see a transaction they took part in — ownership is checked
  // here, not in the UI.
  if (!rows.length) throw errors.notFound('Транзакцію')

  const counterparties = await loadCounterparties(rows)
  return {
    id: transactionId,
    type: rows[0]!.txType,
    createdAt: iso(rows[0]!.createdAt),
    meta: sanitizeMeta(rows[0]!.txMeta as Record<string, unknown> | null),
    legs: rows.map((row) => serializeEntry(row, counterparties)),
  }
}

async function loadCounterparties(rows: Array<{ counterpartyId: string | null }>): Promise<Counterparties> {
  const ids = [...new Set(rows.map((r) => r.counterpartyId).filter(Boolean))]
  if (!ids.length) return new Map()
  const people = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(sql`${users.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
  return new Map(people.map((p) => [p.id, { id: p.id, name: p.displayName }]))
}

function serializeEntry(row: EntryRow, counterparties: Counterparties) {
  return {
    id: row.id,
    transactionId: row.transactionId,
    type: row.entryType,
    currency: row.currency,
    amount: money(row.amount),
    held: row.accountKind === 'user_hold',
    comment: row.comment,
    counterparty: row.counterpartyId ? (counterparties.get(row.counterpartyId) ?? null) : null,
    createdAt: iso(row.createdAt),
  }
}

/** Meta may carry internal ids; only the fields the UI needs are exposed. */
function sanitizeMeta(meta: Record<string, unknown> | null = {}) {
  const allowed = ['fee', 'feePolicyId', 'rate', 'quoteId', 'reason']
  return Object.fromEntries(
    Object.entries(meta ?? {})
      .filter(([key]) => allowed.includes(key))
      .map(([key, value]) => [key, typeof value === 'bigint' ? money(value) : value]),
  )
}
