import { sql } from 'drizzle-orm'
import { db } from '../src/db/index.js'
import { currencies, feePolicies, users } from '../db/schema/index.js'
import { newId } from '../src/money/amount.js'
import { userWallet } from '../src/money/accounts.js'
import { topUp } from '../src/domain/transfers.js'

// Tests run against the same local Postgres as dev (docker compose up -d) and
// wipe the transactional tables between files. They are deliberately not
// mocked: the invariants being tested are database behaviour.
export async function resetDb() {
  await db.execute(sql`
    TRUNCATE repayment_splits, repayments, loan_shares, loans, fundings,
             funding_requests, starting_capital, registers, businesses,
             balance_snapshots, fx_quotes, idempotency_records, audit_log,
             ledger_entries, transactions, account_balances, accounts,
             sessions, users
    RESTART IDENTITY CASCADE
  `)
  await db
    .insert(currencies)
    .values([
      { code: 'UAH', name: 'Гривня', exponent: 2, isBase: true },
      { code: 'USD', name: 'Долар', exponent: 2 },
    ])
    .onConflictDoNothing()
}

export async function seedFeePolicy(overrides = {}) {
  const [policy] = await db
    .insert(feePolicies)
    .values({
      id: newId('fee'),
      kind: 'transfer',
      currency: null,
      percentBps: 50,
      minAmount: 100n,
      maxAmount: 5000n,
      payer: 'sender',
      ...overrides,
    })
    .returning()
  return policy
}

export async function makeUser({ capabilities = ['invest'], isAdmin = false, name = 'Тест' } = {}) {
  const [user] = await db
    .insert(users)
    .values({
      id: newId('usr'),
      email: `${newId('e')}@test.local`,
      passwordHash: 'x',
      displayName: name,
      capabilities,
      isAdmin,
    })
    .returning()
  await userWallet(user.id, 'UAH')
  await userWallet(user.id, 'USD')
  return user
}

export async function fund(user, amount, currency = 'UAH') {
  const admin = await makeUser({ isAdmin: true, name: 'Адмін' })
  await topUp({
    adminId: admin.id,
    userId: user.id,
    currency,
    amount: String(amount),
    idempotencyKey: newId('idem'),
  })
}
