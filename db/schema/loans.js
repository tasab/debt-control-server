import { sql } from 'drizzle-orm'
import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core'
import { amount, users } from './core.js'
import { businesses } from './business.js'

// ─── Funding requests (PLATFORM_PLAN §6) ────────────────────────────────────
// status: draft | open | funded | disbursed | expired | cancelled
// `amountFunded` is a cached rollup of fundings; the ledger holds the truth.
export const fundingRequests = pgTable(
  'funding_requests',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    currency: text('currency').notNull(),
    amountTarget: amount('amount_target').notNull(),
    amountFunded: amount('amount_funded').notNull().default(sql`0`),
    rateAnnualBps: integer('rate_annual_bps').notNull(),
    termDays: integer('term_days').notNull(),
    repaymentType: text('repayment_type').notNull(), // bullet | interest_only_flex
    minTicket: amount('min_ticket').notNull().default(sql`10000`),
    minFillBps: integer('min_fill_bps').notNull().default(5000),
    purpose: text('purpose'),
    status: text('status').notNull().default('open'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_requests_status').on(t.status, t.createdAt),
    index('idx_requests_business').on(t.businessId),
  ],
)

// An investor's commitment. While `held`, the money sits in that investor's
// user_hold account — escrow, so it cannot be spent twice while the request
// fills. status: held | released | refunded | cancelled
export const fundings = pgTable(
  'fundings',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id')
      .notNull()
      .references(() => fundingRequests.id),
    investorId: text('investor_id')
      .notNull()
      .references(() => users.id),
    amount: amount('amount').notNull(),
    status: text('status').notNull().default('held'),
    holdTxId: text('hold_tx_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_fundings_request').on(t.requestId, t.status),
    index('idx_fundings_investor').on(t.investorId, t.status),
  ],
)

// status: disbursed | repaying | closed | overdue | defaulted
// (D2: overdue/defaulted are set and shown, but carry no consequences yet.)
export const loans = pgTable(
  'loans',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id')
      .notNull()
      .references(() => fundingRequests.id),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    currency: text('currency').notNull(),
    principal: amount('principal').notNull(),
    outstandingPrincipal: amount('outstanding_principal').notNull(),
    accruedInterest: amount('accrued_interest').notNull().default(sql`0`),
    paidInterest: amount('paid_interest').notNull().default(sql`0`),
    rateAnnualBps: integer('rate_annual_bps').notNull(),
    termDays: integer('term_days').notNull(),
    repaymentType: text('repayment_type').notNull(),
    status: text('status').notNull().default('disbursed'),
    disbursedAt: timestamp('disbursed_at', { withTimezone: true }).notNull().defaultNow(),
    accruedThrough: timestamp('accrued_through', { withTimezone: true }),
    maturesAt: timestamp('matures_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [index('idx_loans_business').on(t.businessId, t.status)],
)

// Shares are frozen at disbursement (D4/§6.5) and Σ shareBps === 10000 exactly.
// Recomputing them per payment is how syndication distribution goes wrong.
export const loanShares = pgTable(
  'loan_shares',
  {
    id: text('id').primaryKey(),
    loanId: text('loan_id')
      .notNull()
      .references(() => loans.id),
    investorId: text('investor_id')
      .notNull()
      .references(() => users.id),
    principalShare: amount('principal_share').notNull(),
    shareBps: integer('share_bps').notNull(),
  },
  (t) => [
    index('idx_shares_loan').on(t.loanId),
    index('idx_shares_investor').on(t.investorId),
  ],
)

// The schedule. status: due | paid | overdue
export const repayments = pgTable(
  'repayments',
  {
    id: text('id').primaryKey(),
    loanId: text('loan_id')
      .notNull()
      .references(() => loans.id),
    seq: integer('seq').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    principalDue: amount('principal_due').notNull().default(sql`0`),
    interestDue: amount('interest_due').notNull().default(sql`0`),
    principalPaid: amount('principal_paid').notNull().default(sql`0`),
    interestPaid: amount('interest_paid').notNull().default(sql`0`),
    status: text('status').notNull().default('due'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (t) => [index('idx_repayments_loan').on(t.loanId, t.dueAt)],
)

// One row per investor per payment — the audit trail behind the N+1 entry
// transaction that distributes a repayment.
export const repaymentSplits = pgTable(
  'repayment_splits',
  {
    id: text('id').primaryKey(),
    repaymentId: text('repayment_id')
      .notNull()
      .references(() => repayments.id),
    investorId: text('investor_id')
      .notNull()
      .references(() => users.id),
    principal: amount('principal').notNull().default(sql`0`),
    interest: amount('interest').notNull().default(sql`0`),
    fee: amount('fee').notNull().default(sql`0`),
    transactionId: text('transaction_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_splits_repayment').on(t.repaymentId)],
)
