import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, index, primaryKey } from 'drizzle-orm/pg-core'
import { amount } from './core.js'

// Written nightly by jobs/snapshots.js. A year-long balance chart is then one
// indexed range scan instead of aggregating a million ledger entries.
// kind: wallet | held | lent | borrowed
export const balanceSnapshots = pgTable(
  'balance_snapshots',
  {
    userId: text('user_id').notNull(),
    date: text('date').notNull(), // YYYY-MM-DD, UTC
    currency: text('currency').notNull(),
    kind: text('kind').notNull(),
    amount: amount('amount').notNull(),
    amountBase: amount('amount_base').notNull().default(sql`0`), // valued in UAH (D8)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.date, t.currency, t.kind] }),
    index('idx_snapshots_user_date').on(t.userId, t.date),
  ],
)
