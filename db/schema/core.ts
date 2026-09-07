import { sql } from 'drizzle-orm'
import type { AccountKind, OwnerType } from '../../src/types.ts'
import {
  pgTable,
  text,
  integer,
  boolean,
  bigint,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core'

// Amounts are always integer minor units (kopiykas/cents) — never float, never
// numeric-in-JS. Postgres `bigint` + drizzle `mode: 'bigint'` keeps them as JS
// BigInt end-to-end; the HTTP boundary serialises them to strings.
export const amount = (name: string) => bigint(name, { mode: 'bigint' })

// ─── Currencies ─────────────────────────────────────────────────────────────
// `exponent` is how many minor units make one major unit (UAH = 2, JPY = 0).
// The client needs it to format; nothing on the server ever divides by it.
export const currencies = pgTable('currencies', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  exponent: integer('exponent').notNull().default(2),
  isActive: boolean('is_active').notNull().default(true),
  isBase: boolean('is_base').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
})

// ─── Users & sessions ───────────────────────────────────────────────────────
// D7: capabilities is an array, not a role enum — growing from ['invest'] to
// ['invest','borrow'] must be an array append, not a migration.
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    capabilities: text('capabilities').array().notNull().default(sql`ARRAY['invest']::text[]`),
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('idx_users_email').on(t.email)],
)

// One row per login. The cookie carries a JWT whose `sid` points here, so a
// session can be revoked server-side (logout, rotation) without waiting for the
// JWT to expire.
//
// `expires_at` = NULL означає «не спливає за часом». Це стан за замовчуванням:
// вихід із додатка має бути рішенням людини, а не наслідком того, що вона
// тиждень не заходила. Відкликання нікуди не поділося — `revoked_at` гасить
// сесію миттєво, і саме воно, а не годинник, лишається запобіжником.
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    rotatedTo: text('rotated_to'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_sessions_user').on(t.userId)],
)

// ─── Публічні посилання на баланс ───────────────────────────────────────────
// Одне посилання — один рядок із власним токеном. Не одне поле в `users`, бо
// посилань буває кілька (одне бухгалтеру, одне партнеру), і відкликати треба
// вміти кожне окремо, не ламаючи решту.
//
// Відкликання — це `revoked_at`, а не DELETE: коли посилання раптом «перестало
// працювати», відповідь «його відкликали такого-то числа» краща за порожнечу.
export const balanceShares = pgTable(
  'balance_shares',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    // 128 біт випадковості в base64url. Токен — єдине, що захищає сторінку,
    // тож він має бути незгадуваним, а не коротким.
    token: text('token').notNull(),
    // Підпис для себе: «для банку», «Петрові». Хто відкриє посилання, його не
    // бачить — це нотатка власника, а не заголовок сторінки.
    label: text('label'),
    viewCount: integer('view_count').notNull().default(0),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_balance_shares_token').on(t.token),
    index('idx_balance_shares_user').on(t.userId),
  ],
)

// ─── Ledger (PLATFORM_PLAN §2.1) ────────────────────────────────────────────
// Повний перелік видів — у src/types.ts (AccountKind); ownerType/ownerId
// кажуть, чий це рахунок: ('user', usr_…), ('business', biz_…),
// ('membership', mem_…) або ('platform', 'platform').
export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    ownerType: text('owner_type').$type<OwnerType>().notNull(),
    ownerId: text('owner_id').notNull(),
    kind: text('kind').$type<AccountKind>().notNull(),
    currency: text('currency')
      .notNull()
      .references(() => currencies.code),
    name: text('name'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One canonical account per (owner, kind, currency). Registers are the
    // exception — a business may hold several — so they are excluded here and
    // are always addressed by their own id.
    uniqueIndex('idx_accounts_identity')
      .on(t.ownerType, t.ownerId, t.kind, t.currency)
      .where(sql`kind <> 'business_register'`),
    index('idx_accounts_owner').on(t.ownerType, t.ownerId),
  ],
)

// Materialised balances, written inside the same SQL transaction as the entries
// that move them. jobs/reconcile.js re-derives them from ledger_entries and
// alerts on drift rather than silently healing.
export const accountBalances = pgTable('account_balances', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => accounts.id),
  balance: amount('balance').notNull().default(sql`0`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const transactions = pgTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    status: text('status').notNull().default('posted'),
    idempotencyKey: text('idempotency_key'),
    actorId: text('actor_id'),
    reversalOf: text('reversal_of'),
    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The idempotency guarantee: a retried request collides here and the caller
    // gets the original transactionId back instead of a second money movement.
    uniqueIndex('idx_transactions_idem').on(t.idempotencyKey),
    index('idx_transactions_created').on(t.createdAt),
  ],
)

// Immutable. Reversal is a compensating transaction, never a DELETE.
// `comment` / `counterpartyId` are denormalised so rendering a history page is
// one indexed read, not a join across several tables.
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: text('id').primaryKey(),
    transactionId: text('transaction_id')
      .notNull()
      .references(() => transactions.id),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    currency: text('currency').notNull(),
    amount: amount('amount').notNull(),
    entryType: text('entry_type'),
    comment: text('comment'),
    counterpartyId: text('counterparty_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_entries_account').on(t.accountId, t.createdAt),
    index('idx_entries_tx').on(t.transactionId),
  ],
)

// ─── Fees (D3, PLATFORM_PLAN §2.4) ──────────────────────────────────────────
// Dated: changing a tariff inserts a new row, it never rewrites history. The
// transaction that used a policy records its id in meta.feePolicyId.
export const feePolicies = pgTable(
  'fee_policies',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(), // transfer | interest_share | origination
    currency: text('currency'), // null = applies to every currency
    percentBps: integer('percent_bps').notNull().default(0),
    fixedAmount: amount('fixed_amount').notNull().default(sql`0`),
    minAmount: amount('min_amount'),
    maxAmount: amount('max_amount'),
    payer: text('payer').notNull().default('sender'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
  },
  (t) => [index('idx_fee_policies_kind').on(t.kind, t.effectiveFrom)],
)

// ─── Audit ──────────────────────────────────────────────────────────────────
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    entity: text('entity'),
    entityId: text('entity_id'),
    data: jsonb('data'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('idx_audit_actor').on(t.actorId, t.ts)],
)

// Idempotency replay cache for writes that do not themselves post to the ledger
// (creating a funding request, cancelling one). Ledger writes get their guard
// from transactions.idempotency_key instead.
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    key: text('key').notNull(),
    scope: text('scope').notNull(),
    userId: text('user_id').notNull(),
    response: jsonb('response').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.key, t.scope] })],
)
