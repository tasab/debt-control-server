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
  | 'loan_principal'
  | 'platform_fee'
  | 'platform_fx'
  | 'external'

export type OwnerType = 'user' | 'business' | 'loan' | 'platform'

export type EntryType =
  | 'transfer_out'
  | 'transfer_in'
  | 'fx'
  | 'fee'
  | 'topup'
  | 'funding_hold'
  | 'funding_release'
  | 'disbursement'
  | 'repayment_in'
  | 'repayment_out'
  | 'interest_accrued'
  | 'internal_in'
  | 'internal_out'

export type RequestStatus = 'draft' | 'open' | 'funded' | 'disbursed' | 'expired' | 'cancelled'
export type LoanStatus = 'disbursed' | 'repaying' | 'closed' | 'overdue' | 'defaulted'
export type RepaymentType = 'bullet' | 'interest_only_flex'
export type FeeKind = 'transfer' | 'interest_share' | 'origination'

/** One side of a ledger transaction. */
export interface LedgerEntryInput {
  accountId: string
  currency: string
  amount: Money
  entryType?: EntryType | string
  comment?: string | null
  counterpartyId?: string | null
  relatedLoanId?: string | null
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
