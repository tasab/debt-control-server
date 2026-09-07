import { pgTable, text, timestamp, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { amount, users, currencies } from './core.ts'
import type { CountLineKind } from '../../src/types.ts'

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

// ─── Вечірній перерахунок ───────────────────────────────────────────────────
// Власник вводить не рух, а факт: «у касі 42 300». Різницю з тим, що каже
// книга, система проводить сама. Сам перерахунок зберігається окремо, бо
// проводки містять лише дельти — а «що я ввів 3 вересня» має лишатись
// відповідним питанням через рік.
export const cashCounts = pgTable(
  'cash_counts',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    // NULL, коли перерахунок збігся з книгою до копійки: факт зафіксовано,
    // проводити не було чого.
    transactionId: text('transaction_id'),
    countedBy: text('counted_by').references(() => users.id),
    note: text('note'),
    countedAt: timestamp('counted_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Помилковий перерахунок не стирається, а сторнується: проводки незмінні
    // (PLATFORM_PLAN §2.3), тож виправлення — це компенсуюча транзакція, і
    // сюди лягає її id. Історія лишається повною, включно з помилкою.
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversedBy: text('reversed_by').references(() => users.id),
    reversalTxId: text('reversal_tx_id'),
  },
  (t) => [index('idx_cash_counts_biz').on(t.businessId, t.countedAt)],
)

export const cashCountLines = pgTable(
  'cash_count_lines',
  {
    id: text('id').primaryKey(),
    countId: text('count_id')
      .notNull()
      .references(() => cashCounts.id),
    accountId: text('account_id').notNull(),
    // 'register' — конкретна каса; 'cash' — готівка поза касами в цій валюті.
    kind: text('kind').$type<CountLineKind>().notNull(),
    registerId: text('register_id').references(() => registers.id),
    currency: text('currency').notNull(),
    counted: amount('counted').notNull(),
    previous: amount('previous').notNull(),
    delta: amount('delta').notNull(),
  },
  (t) => [index('idx_cash_count_lines_count').on(t.countId)],
)
