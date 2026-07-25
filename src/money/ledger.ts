import { eq, sql } from 'drizzle-orm'
import {
  accounts,
  accountBalances,
  ledgerEntries,
  transactions,
} from '../../db/schema/index.ts'
import { db } from '../db/index.ts'
import { AppError, errors } from '../errors.ts'
import { newId } from './amount.ts'
import { NON_NEGATIVE_KINDS } from './accounts.ts'
import type {
  DbOrTx,
  LedgerEntryInput,
  PostTransactionInput,
  PostedTransaction,
  Tx,
} from '../types.ts'

/** Shape of the locked-account rows the balance check works from. */
interface AccountState {
  kind: string
  currency: string
  balance: bigint
}

/**
 * The single entry point for moving money. Nothing else in this codebase may
 * INSERT into ledger_entries — `grep -r ledgerEntries src/` should only ever
 * find reads outside this file.
 *
 * Guarantees, all inside one SQL transaction:
 *   1. Σ amount === 0 per currency (money is neither created nor destroyed);
 *   2. accounts are locked FOR UPDATE in id order (no deadlock, no double spend);
 *   3. wallet/hold/register balances never go negative;
 *   4. a repeated Idempotency-Key returns the original transactionId instead of
 *      posting a second time;
 *   5. account_balances moves with the entries, never in a follow-up write.
 *
 * @param {object} input
 * @param {string} input.type            transaction type (transfer, fx, disbursement…)
 * @param {Array}  input.entries         [{ accountId, currency, amount: bigint, ... }]
 * @param {string} [input.idempotencyKey]
 * @param {string} [input.actorId]
 * @param {object} [input.meta]
 * @param {object} [tx]                  existing drizzle transaction to join
 */
export async function postTransaction(
  input: PostTransactionInput,
  tx: Tx | null = null,
): Promise<PostedTransaction> {
  if (tx) return postWithin(tx, input)
  return db.transaction((trx) => postWithin(trx, input))
}

async function postWithin(
  tx: Tx,
  { type, entries, idempotencyKey = null, actorId = null, meta = {} }: PostTransactionInput,
): Promise<PostedTransaction> {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw new AppError('LEDGER_INVALID', 'A transaction needs at least two entries', {
      status: 500,
    })
  }

  // 4. Idempotency — check before doing any work.
  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(tx, idempotencyKey)
    if (existing) {
      if (existing.type !== type) throw errors.idempotencyConflict()
      return { transactionId: existing.id, replayed: true }
    }
  }

  // 1. Balance check, per currency. This is the invariant the whole system
  //    rests on, so it is verified before any row is written.
  const perCurrency = new Map<string, bigint>()
  for (const entry of entries) {
    if (typeof entry.amount !== 'bigint') {
      throw new AppError('LEDGER_INVALID', 'Entry amounts must be BigInt', { status: 500 })
    }
    perCurrency.set(entry.currency, (perCurrency.get(entry.currency) ?? 0n) + entry.amount)
  }
  for (const [currency, total] of perCurrency) {
    if (total !== 0n) {
      throw new AppError(
        'LEDGER_UNBALANCED',
        `Transaction does not balance in ${currency}: Σ = ${total}`,
        { status: 500 },
      )
    }
  }

  // 2. Lock every touched account in a stable order (sorted ids ⇒ no deadlock).
  const accountIds = [...new Set(entries.map((e) => e.accountId))].sort()
  const idList = sql.join(
    accountIds.map((id) => sql`${id}`),
    sql`, `,
  )

  // The balance row must exist before it can be locked — and it must be locked,
  // not merely joined: FOR UPDATE re-reads the locked rows, so a concurrent
  // debit waits here and then sees the balance its predecessor left behind.
  // Locking only `accounts` would let both read the same stale balance and both
  // pass the non-negativity check.
  await tx.execute(
    sql`INSERT INTO ${accountBalances} (account_id)
        SELECT id FROM ${accounts} WHERE id IN (${idList})
        ON CONFLICT DO NOTHING`,
  )
  const locked = await tx.execute(
    sql`SELECT a.id, a.kind, a.currency, b.balance AS balance
        FROM ${accounts} a
        JOIN ${accountBalances} b ON b.account_id = a.id
        WHERE a.id IN (${idList})
        ORDER BY a.id
        FOR UPDATE`,
  )
  const rows = (locked.rows ?? locked) as Array<{
    id: string
    kind: string
    currency: string
    balance: string | number | bigint
  }>
  if (rows.length !== accountIds.length) {
    throw new AppError('LEDGER_INVALID', 'Unknown account in transaction', { status: 500 })
  }
  const state = new Map<string, AccountState>(
    rows.map((r) => [r.id, { kind: r.kind, currency: r.currency, balance: BigInt(r.balance) }]),
  )

  // 3. Apply deltas in memory, then assert non-negativity per account.
  for (const entry of entries) {
    const account = state.get(entry.accountId)
    if (!account) {
      throw new AppError('LEDGER_INVALID', `Unknown account ${entry.accountId}`, { status: 500 })
    }
    if (account.currency !== entry.currency) {
      throw new AppError(
        'LEDGER_INVALID',
        `Entry currency ${entry.currency} does not match account ${entry.accountId} (${account.currency})`,
        { status: 500 },
      )
    }
    account.balance += entry.amount
  }
  for (const [accountId, account] of state) {
    if (NON_NEGATIVE_KINDS.has(account.kind) && account.balance < 0n) {
      throw errors.insufficientFunds({
        amount: `недостатньо ${account.currency} на рахунку`,
        accountId,
      })
    }
  }

  // Write. A concurrent request with the same key loses the unique-index race
  // here and gets the winner's transaction id back, exactly as if it had
  // checked first.
  const transactionId = newId('txn')
  try {
    await tx.insert(transactions).values({
      id: transactionId,
      type,
      status: 'posted',
      idempotencyKey,
      actorId,
      meta,
    })
  } catch (err) {
    if (isUniqueViolation(err) && idempotencyKey) {
      const existing = await findByIdempotencyKey(tx, idempotencyKey)
      if (existing) return { transactionId: existing.id, replayed: true }
    }
    throw err
  }

  await tx.insert(ledgerEntries).values(
    entries.map((entry) => ({
      id: newId('led'),
      transactionId,
      accountId: entry.accountId,
      currency: entry.currency,
      amount: entry.amount,
      entryType: entry.entryType ?? type,
      comment: entry.comment ?? null,
      counterpartyId: entry.counterpartyId ?? null,
      relatedLoanId: entry.relatedLoanId ?? null,
    })),
  )

  // 5. Materialised balances move in the same transaction as the entries.
  for (const [accountId, account] of state) {
    await tx
      .insert(accountBalances)
      .values({ accountId, balance: account.balance, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: accountBalances.accountId,
        set: { balance: account.balance, updatedAt: new Date() },
      })
  }

  return { transactionId, replayed: false }
}

async function findByIdempotencyKey(tx: Tx, key: string) {
  const [row] = await tx
    .select()
    .from(transactions)
    .where(eq(transactions.idempotencyKey, key))
    .limit(1)
  return row ?? null
}

function isUniqueViolation(err: unknown): boolean {
  const candidate = err as { code?: string; cause?: { code?: string } } | null
  return candidate?.code === '23505' || candidate?.cause?.code === '23505'
}

/** Reversal is a compensating transaction — entries are immutable (§2.3). */
export async function reverseTransaction(
  { transactionId, actorId, reason }: { transactionId: string; actorId?: string; reason?: string },
  tx: Tx | null = null,
): Promise<PostedTransaction> {
  const run = async (trx: Tx): Promise<PostedTransaction> => {
    const original = await trx
      .select()
      .from(transactions)
      .where(eq(transactions.id, transactionId))
      .limit(1)
    if (!original.length) throw errors.notFound('Транзакцію')

    const entries = await trx
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, transactionId))

    const result = await postWithin(trx, {
      type: `${original[0].type}_reversal`,
      actorId,
      meta: { reversalOf: transactionId, reason },
      entries: entries.map<LedgerEntryInput>((e) => ({
        accountId: e.accountId,
        currency: e.currency,
        amount: -e.amount,
        comment: reason,
      })),
    })
    await trx
      .update(transactions)
      .set({ reversalOf: transactionId })
      .where(eq(transactions.id, result.transactionId))
    return result
  }
  return tx ? run(tx) : db.transaction(run)
}

/** Truth for a single account, derived — used by the reconciliation job. */
export async function computeBalance(accountId: string, tx: DbOrTx = db): Promise<bigint> {
  const [row] = await tx
    .select({ total: sql`COALESCE(SUM(${ledgerEntries.amount}), 0)` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId))
  return BigInt((row?.total ?? 0) as string | number | bigint)
}

/** Σ of every entry per currency. Must be 0 for the whole system, always. */
export async function ledgerTotals(tx: DbOrTx = db): Promise<Array<{ currency: string; total: bigint }>> {
  const rows = await tx
    .select({
      currency: ledgerEntries.currency,
      total: sql`SUM(${ledgerEntries.amount})`,
    })
    .from(ledgerEntries)
    .groupBy(ledgerEntries.currency)
  return rows.map((r) => ({ currency: r.currency, total: BigInt(r.total as string) }))
}
