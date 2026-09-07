import { and, eq } from 'drizzle-orm'
import { accounts, accountBalances } from '../../db/schema/index.ts'
import { db } from '../db/index.ts'
import { newId } from './amount.ts'
import type { AccountKind, DbOrTx, OwnerType } from '../types.ts'

export type Account = typeof accounts.$inferSelect

// Account kinds whose balance may never go below zero. Everything else
// (platform pots, `external`) is expected to sit negative — that is what
// makes the ledger sum to zero.
export const NON_NEGATIVE_KINDS = new Set([
  'user_wallet',
  'user_hold',
  'business_register',
  'business_cash',
])

// Дзеркало NON_NEGATIVE_KINDS: борг перед учасником ніколи не буває додатним.
// Плюс на member_claim означав би, що учасник забрав більше, ніж вклав, — це
// не борг бізнесу, а борг учасника, і такої операції в моделі немає.
export const NON_POSITIVE_KINDS = new Set(['member_claim'])

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

/** Готівка поза касами — по одному рахунку на валюту, створюється за потреби. */
export const businessCash = (businessId: string, currency: string, tx?: DbOrTx) =>
  ensureAccount({ ownerType: 'business', ownerId: businessId, kind: 'business_cash', currency }, tx)

// P&L. Ні дохід, ні витрата не входять до NON_NEGATIVE_KINDS: сторнування
// має лишатися можливим, а знак тут — наслідок проводок, не обмеження.
export const businessIncome = (businessId: string, currency: string, tx?: DbOrTx) =>
  ensureAccount({ ownerType: 'business', ownerId: businessId, kind: 'business_income', currency }, tx)

export const businessExpense = (businessId: string, currency: string, tx?: DbOrTx) =>
  ensureAccount({ ownerType: 'business', ownerId: businessId, kind: 'business_expense', currency }, tx)

/**
 * Власний капітал: скільки грошей власник вклав у бізнес зі своєї кишені.
 *
 * Живе від'ємним, як і будь-яке джерело коштів: гроші прийшли ззовні, і
 * бізнес їх не заробляв. Пара до `business_draw` — вкладено і забрано.
 */
export const businessCapital = (businessId: string, currency: string, tx?: DbOrTx) =>
  ensureAccount({ ownerType: 'business', ownerId: businessId, kind: 'business_capital', currency }, tx)

/** Вилучення власником — накопичувально, окремо від витрат. */
export const businessDraw = (businessId: string, currency: string, tx?: DbOrTx) =>
  ensureAccount({ ownerType: 'business', ownerId: businessId, kind: 'business_draw', currency }, tx)

/**
 * Борг бізнесу перед одним учасником в одній валюті.
 *
 * Власник — участь, а не людина: та сама людина може вкластися у два бізнеси,
 * і зливати ці два борги в один рахунок було б помилкою.
 */
export const memberClaim = (memberId: string, currency: string, tx?: DbOrTx) =>
  ensureAccount({ ownerType: 'membership', ownerId: memberId, kind: 'member_claim', currency }, tx)

export const platformFee = (currency: string, tx?: DbOrTx) =>
  ensureAccount({ ...PLATFORM_OWNER, kind: 'platform_fee', currency }, tx)

export const platformFx = (currency: string, tx?: DbOrTx) =>
  ensureAccount({ ...PLATFORM_OWNER, kind: 'platform_fx', currency }, tx)

export const externalAccount = (currency: string, tx?: DbOrTx) =>
  ensureAccount({ ...PLATFORM_OWNER, kind: 'external', currency }, tx)

