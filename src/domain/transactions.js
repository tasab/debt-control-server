import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { accounts, ledgerEntries, transactions, users } from '../../db/schema/index.js'
import { errors } from '../errors.js'
import { decodeCursor, encodeCursor, iso, money } from '../serialize.js'

/**
 * History is read from the user's own ledger entries: one row per movement,
 * already signed from that user's point of view. No aggregation, no joins onto
 * the counterparty's side — an entry is what happened to *this* account.
 */
export async function listTransactions(userId, query = {}) {
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
      relatedLoanId: ledgerEntries.relatedLoanId,
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
    nextCursor:
      rows.length > limit
        ? encodeCursor({ createdAt: page.at(-1).createdAt, id: page.at(-1).id })
        : null,
  }
}

export async function getTransaction(userId, transactionId) {
  const rows = await db
    .select({
      id: ledgerEntries.id,
      transactionId: ledgerEntries.transactionId,
      entryType: ledgerEntries.entryType,
      currency: ledgerEntries.currency,
      amount: ledgerEntries.amount,
      comment: ledgerEntries.comment,
      counterpartyId: ledgerEntries.counterpartyId,
      relatedLoanId: ledgerEntries.relatedLoanId,
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
    type: rows[0].txType,
    createdAt: iso(rows[0].createdAt),
    meta: sanitizeMeta(rows[0].txMeta),
    legs: rows.map((row) => serializeEntry(row, counterparties)),
  }
}

async function loadCounterparties(rows) {
  const ids = [...new Set(rows.map((r) => r.counterpartyId).filter(Boolean))]
  if (!ids.length) return new Map()
  const people = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(sql`${users.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
  return new Map(people.map((p) => [p.id, { id: p.id, name: p.displayName }]))
}

function serializeEntry(row, counterparties) {
  return {
    id: row.id,
    transactionId: row.transactionId,
    type: row.entryType,
    currency: row.currency,
    amount: money(row.amount),
    held: row.accountKind === 'user_hold',
    comment: row.comment,
    counterparty: row.counterpartyId ? (counterparties.get(row.counterpartyId) ?? null) : null,
    relatedLoanId: row.relatedLoanId,
    createdAt: iso(row.createdAt),
  }
}

/** Meta may carry internal ids; only the fields the UI needs are exposed. */
function sanitizeMeta(meta = {}) {
  const allowed = ['fee', 'feePolicyId', 'rate', 'quoteId', 'requestId', 'loanId', 'reason']
  return Object.fromEntries(
    Object.entries(meta ?? {})
      .filter(([key]) => allowed.includes(key))
      .map(([key, value]) => [key, typeof value === 'bigint' ? money(value) : value]),
  )
}
