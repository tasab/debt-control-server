import { and, eq } from 'drizzle-orm'
import { accounts, accountBalances } from '../../db/schema/index.ts'
import { db } from '../db/index.ts'
import { newId } from './amount.ts'
import type { AccountKind, DbOrTx, OwnerType } from '../types.ts'

export type Account = typeof accounts.$inferSelect

// Account kinds whose balance may never go below zero. Everything else
// (platform pots, `external`, loan principal) is expected to sit negative —
// that is what makes the ledger sum to zero.
export const NON_NEGATIVE_KINDS = new Set(['user_wallet', 'user_hold', 'business_register'])

export const PLATFORM_OWNER = { ownerType: 'platform', ownerId: 'platform' } as const

/**
 * Find-or-create the canonical account for (owner, kind, currency).
 * Registers are never created through here — they carry their own id and are
 * created by domain/businesses.js.
 */
export async function ensureAccount(
  {
    ownerType,
    ownerId,
    kind,
    currency,
    name = null,
  }: {
    ownerType: OwnerType
    ownerId: string
    kind: AccountKind
    currency: string
    name?: string | null
  },
  tx: DbOrTx = db,
): Promise<Account> {
  const [existing] = await tx
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.ownerType, ownerType),
        eq(accounts.ownerId, ownerId),
        eq(accounts.kind, kind),
        eq(accounts.currency, currency),
      ),
    )
    .limit(1)
  if (existing) return existing

  const [created] = await tx
    .insert(accounts)
    .values({ id: newId('acc'), ownerType, ownerId, kind, currency, name })
    .onConflictDoNothing()
    .returning()
  if (created) {
    await tx.insert(accountBalances).values({ accountId: created.id }).onConflictDoNothing()
    return created
  }

  // Lost the race with a concurrent insert — the row exists now.
  return ensureAccount({ ownerType, ownerId, kind, currency, name }, tx)
}

export const userWallet = (userId: string, currency: string, tx?: DbOrTx) =>
  ensureAccount({ ownerType: 'user', ownerId: userId, kind: 'user_wallet', currency }, tx)

export const userHold = (userId: string, currency: string, tx?: DbOrTx) =>
  ensureAccount({ ownerType: 'user', ownerId: userId, kind: 'user_hold', currency }, tx)

export const businessWallet = (businessId: string, currency: string, tx?: DbOrTx) =>
  ensureAccount({ ownerType: 'business', ownerId: businessId, kind: 'user_wallet', currency }, tx)

export const platformFee = (currency: string, tx?: DbOrTx) =>
  ensureAccount({ ...PLATFORM_OWNER, kind: 'platform_fee', currency }, tx)

export const platformFx = (currency: string, tx?: DbOrTx) =>
  ensureAccount({ ...PLATFORM_OWNER, kind: 'platform_fx', currency }, tx)

export const externalAccount = (currency: string, tx?: DbOrTx) =>
  ensureAccount({ ...PLATFORM_OWNER, kind: 'external', currency }, tx)

export const loanPrincipal = (loanId: string, currency: string, tx?: DbOrTx) =>
  ensureAccount({ ownerType: 'loan', ownerId: loanId, kind: 'loan_principal', currency }, tx)
