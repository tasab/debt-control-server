import { pgTable, text, timestamp, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { amount, users, currencies } from './core.js'

// A business profile belongs to exactly one user with the `borrow` capability.
// Starting capital is a dated setting (PLATFORM_PLAN §5) — the P&L baseline,
// not a field anyone edits retroactively.
export const businesses = pgTable(
  'businesses',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    description: text('description'),
    baseCurrency: text('base_currency')
      .notNull()
      .references(() => currencies.code),
    isVerified: boolean('is_verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('idx_businesses_owner').on(t.ownerUserId)],
)

export const startingCapital = pgTable(
  'starting_capital',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    amount: amount('amount').notNull(),
    currency: text('currency').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_starting_capital_biz').on(t.businessId, t.effectiveFrom)],
)

// A register (каса) is a physical cash point. It is backed by an account of
// kind 'business_register', so "how much UAH is in register 1" is the same
// SUM(ledger_entries) query as any other balance.
export const registers = pgTable(
  'registers',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    accountId: text('account_id').notNull(),
    name: text('name').notNull(),
    currency: text('currency').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('idx_registers_biz').on(t.businessId)],
)
