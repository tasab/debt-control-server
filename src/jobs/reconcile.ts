import { sql } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { ledgerTotals } from '../money/ledger.ts'

/**
 * Daily integrity check (PLATFORM_PLAN §8):
 *   1. Σ ledger_entries per currency must be exactly 0;
 *   2. account_balances must equal SUM(ledger_entries) per account.
 * A discrepancy is reported loudly and NOT auto-healed — silently rewriting a
 * balance would erase the evidence of whatever caused the drift.
 */
export async function reconcile(log: Partial<Console> = console): Promise<unknown[]> {
  const problems: Array<Record<string, string>> = []

  for (const { currency, total } of await ledgerTotals()) {
    if (total !== 0n) problems.push({ kind: 'currency_imbalance', currency, total: total.toString() })
  }

  const drift = await db.execute(sql`
    SELECT a.id,
           COALESCE(b.balance, 0) AS materialised,
           COALESCE(SUM(e.amount), 0) AS derived
    FROM accounts a
    LEFT JOIN account_balances b ON b.account_id = a.id
    LEFT JOIN ledger_entries e ON e.account_id = a.id
    GROUP BY a.id, b.balance
    HAVING COALESCE(b.balance, 0) <> COALESCE(SUM(e.amount), 0)
  `)
  for (const row of (drift.rows ?? drift) as Array<Record<string, unknown>>) {
    problems.push({
      kind: 'balance_drift',
      accountId: String(row.id),
      materialised: String(row.materialised),
      derived: String(row.derived),
    })
  }

  if (problems.length) {
    log.error?.({ problems }, 'reconcile: LEDGER INTEGRITY FAILURE')
  } else {
    log.info?.('reconcile: ledger balanced')
  }
  return problems
}
