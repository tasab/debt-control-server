import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import type { db } from './db/index.ts'

/**
 * Shared vocabulary for the whole server. Two things earn a name here:
 * amounts (always BigInt in memory, always a string on the wire) and the
 * account model the ledger is built on.
 */

/** Minor units. Never a number — see money/amount.ts. */
export type Money = bigint

/** What a Money looks like once it leaves over HTTP: "100500". */
export type MoneyString = string

export type Capability = 'invest' | 'borrow'

export type AccountKind =
  | 'user_wallet'
  | 'user_hold'
  | 'business_register'
  // Готівка бізнесу поза касами, по одному рахунку на валюту — те, що
  // власник перераховує ввечері разом із касами.
  | 'business_cash'
  // Дві половини P&L. Виторг накопичується від'ємним, витрати додатним, і
  // разом вони — друга сторона кожного коригування при перерахунку.
  | 'business_income'
  | 'business_expense'
  // Вилучення власником. Не витрата: гроші не втрачені, вони роздані. Тому
  // цей рахунок стоїть окремо й на прибуток не впливає — інакше «забрав
  // зароблене» читалося б як «не заробив».
  | 'business_draw'
  // Власні гроші, вкладені власником у бізнес. Не виторг: бізнес їх не
  // заробив, їх принесли. І не борг перед учасником: винен самому собі не
  // буваєш. Це третя річ — власний капітал, і без окремого рахунку він
  // неминуче потрапляв би у прибуток.
  | 'business_capital'
  // Борг бізнесу перед учасником. Єдиний вид рахунку, який ніколи не буває
  // додатним: це зобов'язання, і воно живе з протилежним знаком до активів.
  | 'member_claim'
  | 'platform_fee'
  | 'platform_fx'
  | 'external'

// 'membership' — рахунок належить не людині взагалі, а її участі в конкретному
// бізнесі: та сама людина може вкластися у два бізнеси, і це два різні борги.
export type OwnerType = 'user' | 'business' | 'platform' | 'membership'

export type EntryType =
  | 'transfer_out'
  | 'transfer_in'
  | 'fx'
  | 'fee'
  | 'topup'
  // Людина записала собі власні кошти сама, без адміна. Окремий тип, а не
  // `topup`: у виписці має бути видно, які гроші провів адміністратор, а які
  // власник вписав із голови — інакше зошит не відрізнити від підробки.
  | 'self_topup'
  | 'interest_accrued'
  // Admin correction of a participant's wallet — balanced against `external`,
  // like a top-up, because a balance is a ledger sum and never a field.
  | 'adjustment'
  | 'internal_in'
  | 'internal_out'
  // Вечірній перерахунок: різниця між порахованим і тим, що каже книга.
  // Надлишок — виторг дня, нестача — витрата.
  | 'count_adjustment'
  | 'count_surplus'
  | 'count_shortfall'
  // Названі рухи грошей з каси: витрата з причиною і вилучення прибутку.
  | 'expense'
  | 'draw'
  | 'capital'
  // Вклад учасника: гроші прийшли в касу, борг перед учасником виріс.
  | 'contribution_in'
  | 'contribution_out'
  // Переказ між учасниками одного бізнесу: каси не рухаються, міняється
  // тільки те, кому бізнес винен.
  | 'claim_out'
  | 'claim_in'

// 'declined' окремо від 'ended': людина, яка відмовилась одразу, і людина,
// яка була в бізнесі й вийшла, — різні історії, і список учасників не має
// показувати їх однаково.
export type MemberStatus = 'pending' | 'active' | 'declined' | 'ended'
export type ContributionDirection = 'in' | 'out'
export type ContributionStatus = 'pending' | 'accepted' | 'rejected'

/** Рядок перерахунку: конкретна каса, або готівка поза касами в одній валюті. */
export type CountLineKind = 'register' | 'cash'

export type FeeKind = 'transfer'

/** One side of a ledger transaction. */
export interface LedgerEntryInput {
  accountId: string
  currency: string
  amount: Money
  entryType?: EntryType | string
  comment?: string | null
  counterpartyId?: string | null
}

export interface PostTransactionInput {
  type: string
  entries: LedgerEntryInput[]
  idempotencyKey?: string | null
  actorId?: string | null
  meta?: Record<string, unknown>
}

export interface PostedTransaction {
  transactionId: string
  replayed: boolean
}

/**
 * A drizzle transaction handle, or the root client. Domain functions take this
 * so they compose inside one SQL transaction — that is what keeps a repayment
 * and its splits from ever being half-written.
 */
export type Db = typeof db
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export type DbOrTx = Db | Tx

/** The authenticated user attached to a request by plugins/auth.ts. */
export interface AuthUser {
  id: string
  email: string
  displayName: string
  capabilities: string[]
  isAdmin: boolean
  sessionId: string
  expiresAt: Date
}

export interface RequestContext {
  ip?: string | null
  userAgent?: string | null
}

export const contextOf = (request: FastifyRequest): RequestContext => ({
  ip: request.ip,
  userAgent: request.headers['user-agent'] ?? null,
})

// Fastify decorators, declared once so every route file sees them.
declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser
  }
  interface FastifyInstance {
    authenticate: preHandlerAsyncHookHandler
    optionalAuth: preHandlerAsyncHookHandler
    guard: (required?: Array<Capability | 'admin'>) => preHandlerAsyncHookHandler
  }
}
