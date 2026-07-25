import 'dotenv/config'
import { hash } from '@node-rs/argon2'
import { eq, sql } from 'drizzle-orm'
import { db, pool } from '../../src/db/index.ts'
import {
  businesses,
  currencies,
  feePolicies,
  rateSources,
  startingCapital,
  users,
} from '../schema/index.ts'
import { config } from '../../src/config.ts'
import { newId } from '../../src/money/amount.ts'
import { userWallet } from '../../src/money/accounts.ts'
import { topUp } from '../../src/domain/transfers.ts'
import { refreshRates } from '../../src/fx/job.ts'

// A demo world you can log into: investor, business owner, admin (§10 Ф0).
// Re-runnable — every insert is upsert-shaped, so seeding twice is harmless.
const CURRENCIES = [
  { code: 'UAH', name: 'Гривня', exponent: 2, isBase: true, sortOrder: 0 },
  { code: 'USD', name: 'Долар США', exponent: 2, sortOrder: 1 },
  { code: 'EUR', name: 'Євро', exponent: 2, sortOrder: 2 },
  { code: 'GBP', name: 'Фунт стерлінгів', exponent: 2, sortOrder: 3 },
  { code: 'PLN', name: 'Злотий', exponent: 2, sortOrder: 4 },
]

type SeedPerson = {
  email: string
  displayName: string
  capabilities: string[]
  isAdmin?: boolean
}

const PEOPLE: SeedPerson[] = [
  { email: 'investor@debt.local', displayName: 'Олекса Інвестор', capabilities: ['invest'] },
  { email: 'business@debt.local', displayName: 'Марія Підприємець', capabilities: ['borrow'] },
  { email: 'admin@debt.local', displayName: 'Адміністратор', capabilities: ['invest', 'borrow'], isAdmin: true },
]

const PASSWORD = 'password123'

async function main() {
  await db
    .insert(currencies)
    .values(CURRENCIES)
    .onConflictDoUpdate({
      target: currencies.code,
      set: { name: sql`excluded.name`, exponent: sql`excluded.exponent` },
    })

  await db
    .insert(rateSources)
    .values([
      { id: 'hardcoded', name: 'Hardcoded (Ф2)', priority: 100 },
      { id: 'external', name: 'External API (Ф7)', priority: 10, isActive: false },
    ])
    .onConflictDoNothing()

  // Fee policies (D3). Dated from now — changing a tariff later inserts a new
  // row instead of editing this one.
  await db
    .insert(feePolicies)
    .values([
      {
        id: 'fee_transfer_default',
        kind: 'transfer',
        currency: null,
        percentBps: config.fees.transferPercentBps,
        minAmount: config.fees.transferMin,
        maxAmount: config.fees.transferMax,
        payer: 'sender',
      },
      {
        id: 'fee_interest_share_default',
        kind: 'interest_share',
        currency: null,
        percentBps: config.fees.interestShareBps,
        payer: 'investor',
      },
      {
        id: 'fee_origination_default',
        kind: 'origination',
        currency: null,
        percentBps: config.fees.originationBps,
        payer: 'borrower',
      },
    ])
    .onConflictDoNothing()

  const passwordHash = await hash(PASSWORD)
  const created: Record<string, typeof users.$inferSelect> = {}
  for (const person of PEOPLE) {
    const [existing] = await db.select().from(users).where(eq(users.email, person.email)).limit(1)
    if (existing) {
      created[person.email] = existing
      continue
    }
    const [user] = await db
      .insert(users)
      .values({ id: newId('usr'), passwordHash, ...person })
      .returning()
    created[person.email] = user!
    for (const currency of CURRENCIES) await userWallet(user.id, currency.code)
  }

  const admin = created['admin@debt.local']!
  const investor = created['investor@debt.local']!
  const owner = created['business@debt.local']!

  // Business profile with a dated starting capital — the P&L baseline.
  const [existingBusiness] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.ownerUserId, owner.id))
    .limit(1)
  if (!existingBusiness) {
    const [business] = await db
      .insert(businesses)
      .values({
        id: newId('biz'),
        ownerUserId: owner.id,
        name: 'Кав’ярня «Друга Хвиля»',
        description: 'Дві точки в центрі, обіг ~180 тис. грн/міс.',
        baseCurrency: 'UAH',
        isVerified: true,
      })
      .returning()
    await db.insert(startingCapital).values({
      id: newId('cap'),
      businessId: business.id,
      amount: 50_000_00n,
      currency: 'UAH',
    })
  }

  // Money enters only through an admin top-up, even in the seed (D1).
  await topUp({
    adminId: admin.id,
    userId: investor.id,
    currency: 'UAH',
    amount: '50000000',
    comment: 'демо-поповнення',
    idempotencyKey: 'seed-topup-investor-uah',
  })
  await topUp({
    adminId: admin.id,
    userId: investor.id,
    currency: 'USD',
    amount: '500000',
    comment: 'демо-поповнення',
    idempotencyKey: 'seed-topup-investor-usd',
  })
  await topUp({
    adminId: admin.id,
    userId: owner.id,
    currency: 'UAH',
    amount: '10000000',
    comment: 'демо-поповнення',
    idempotencyKey: 'seed-topup-business-uah',
  })

  await refreshRates(console)

  console.log('Seeded. Log in with any of:')
  for (const person of PEOPLE) console.log(`  ${person.email} / ${PASSWORD}`)
}

await main()
await pool.end()
