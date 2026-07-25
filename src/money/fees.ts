import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { feePolicies } from '../../db/schema/index.ts'
import { applyBpsCeil, max, min } from './amount.ts'
import type { DbOrTx, FeeKind, Money } from '../types.ts'

export type FeePolicy = typeof feePolicies.$inferSelect

export interface FeeQuote {
  amount: Money
  fee: Money
  total: Money
  received: Money
  payer: string
  policyId: string | null
}

/**
 * Fee calculation, kept away from the routes so a tariff change is a data
 * change. Policies are dated: the one in force at `at` wins, and the caller
 * stores its id on the transaction so history stays reproducible.
 *
 * Rounding is always `ceil` — in the platform's favour, per PLATFORM_PLAN §2.4.
 * A 0% policy is valid and yields a zero fee, which is how fees get switched
 * off for testing without touching code.
 */
export async function findPolicy(
  kind: FeeKind | string,
  currency: string | null,
  at: Date = new Date(),
  tx: DbOrTx = db,
): Promise<FeePolicy | null> {
  const [policy] = await tx
    .select()
    .from(feePolicies)
    .where(
      and(
        eq(feePolicies.kind, kind),
        or(isNull(feePolicies.currency), eq(feePolicies.currency, currency ?? '')),
        sql`${feePolicies.effectiveFrom} <= ${at}`,
        or(isNull(feePolicies.effectiveTo), sql`${feePolicies.effectiveTo} > ${at}`),
      ),
    )
    // Currency-specific policies beat the catch-all; newer beats older.
    .orderBy(sql`${feePolicies.currency} NULLS LAST`, desc(feePolicies.effectiveFrom))
    .limit(1)
  return policy ?? null
}

export function computeFee(
  policy: FeePolicy | null,
  amount: Money,
): { fee: Money; policyId: string | null; payer: string } {
  if (!policy) return { fee: 0n, policyId: null, payer: 'sender' }
  let fee = applyBpsCeil(amount, policy.percentBps) + policy.fixedAmount
  if (policy.minAmount != null) fee = max(fee, policy.minAmount)
  if (policy.maxAmount != null) fee = min(fee, policy.maxAmount)
  // A fee may never exceed the amount it is charged on — that would let a
  // transfer take more than it moves.
  fee = min(fee, amount)
  return { fee, policyId: policy.id, payer: policy.payer }
}

/**
 * What a transfer of `amount` costs. `payer: 'sender'` means the fee is charged
 * on top (sender pays total, recipient gets amount); `'recipient'` means it is
 * taken out of the amount.
 */
export async function previewFee(
  {
    kind,
    currency,
    amount,
    at = new Date(),
  }: { kind: FeeKind | string; currency: string; amount: Money; at?: Date },
  tx: DbOrTx = db,
): Promise<FeeQuote> {
  const policy = await findPolicy(kind, currency, at, tx)
  const { fee, policyId, payer } = computeFee(policy, amount)
  return {
    amount,
    fee,
    total: payer === 'sender' ? amount + fee : amount,
    received: payer === 'sender' ? amount : amount - fee,
    payer,
    policyId,
  }
}
