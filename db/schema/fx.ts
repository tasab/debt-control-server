import { pgTable, text, integer, boolean, timestamp, index, bigint } from 'drizzle-orm/pg-core'
import { currencies } from './core.ts'

// Rates are stored as integers scaled by RATE_SCALE (1e6): 40.00 → 40_000_000.
// Same reasoning as money — no floats anywhere near a balance.
const rate = (name: string) => bigint(name, { mode: 'bigint' })

export const rateSources = pgTable('rate_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  priority: integer('priority').notNull().default(100),
  isActive: boolean('is_active').notNull().default(true),
})

// A quote is a historical fact, not a current value: we append rows and read
// the newest valid one. That is what makes "which rate applied at 14:32"
// answerable and what keeps a provider outage from blocking operations.
export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => rateSources.id),
    base: text('base').notNull(), // always UAH (D8)
    quote: text('quote')
      .notNull()
      .references(() => currencies.code),
    bid: rate('bid').notNull(), // platform BUYS quote currency at this price
    sell: rate('sell').notNull(), // platform SELLS quote currency at this price
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [index('idx_rates_pair').on(t.base, t.quote, t.observedAt)],
)

// Quote-lock (PLATFORM_PLAN §3.2): the user sees exact amounts, then executes
// against this row. `consumedByTx` makes a quote single-use.
export const fxQuotes = pgTable(
  'fx_quotes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    fromCurrency: text('from_currency').notNull(),
    toCurrency: text('to_currency').notNull(),
    amountFrom: bigint('amount_from', { mode: 'bigint' }).notNull(),
    amountTo: bigint('amount_to', { mode: 'bigint' }).notNull(),
    rateUsed: rate('rate_used').notNull(),
    side: text('side').notNull(), // 'bid' | 'sell' — which side was applied
    rateId: text('rate_id').references(() => exchangeRates.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedByTx: text('consumed_by_tx'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_fx_quotes_user').on(t.userId, t.createdAt)],
)
