import 'dotenv/config'
import { hash } from '@node-rs/argon2'
import { db, pool } from '../../src/db/index.ts'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { currencies, feePolicies, rateSources, users } from '../schema/index.ts'
import { config } from '../../src/config.ts'
import { newId } from '../../src/money/amount.ts'
import { userWallet } from '../../src/money/accounts.ts'
import { refreshRates } from '../../src/fx/job.ts'

/**
 * Мінімум, без якого база не працює, — і жодного демо-світу.
 *
 * Тут навмисно немає ані вигаданих користувачів із балансами, ані кав’ярні з
 * касами: сід ставить довідники (валюти, джерела курсів, тарифи) і один
 * адмінський акаунт, з якого можна увійти. Усе інше — справжні дані, які
 * заводить людина.
 *
 * Гроші в системі з’являються лише через поповнення адміністратором (D1), тож
 * адмін тут не зручність, а єдиний спосіб узагалі почати: зареєстрований
 * самотужки користувач такого права не має.
 *
 * Прогін безпечний повторно, і це не зручність, а вимога: сід стоїть у
 * команді старту (railway.json), тобто виконується на кожен деплой.
 *
 * Тому довідники — upsert (сходяться до описаного тут стану), а адмін
 * створюється лише тоді, коли адміна немає взагалі. Інакше кожен деплой
 * мовчки скидав би пароль на той, що лежить у змінних, — і зміна пароля в
 * додатку жила б рівно до наступного пушу.
 */

// Порядок — за частотою: гривня, три ходові валюти, далі решта. Він задає
// порядок у кожному списку валют, тож USD/EUR/PLN завжди під рукою.
const CURRENCIES = [
  { code: 'UAH', name: 'Гривня', exponent: 2, isBase: true, sortOrder: 0 },
  { code: 'USD', name: 'Долар США', exponent: 2, sortOrder: 1 },
  { code: 'EUR', name: 'Євро', exponent: 2, sortOrder: 2 },
  { code: 'PLN', name: 'Злотий', exponent: 2, sortOrder: 3 },
  { code: 'GBP', name: 'Фунт стерлінгів', exponent: 2, sortOrder: 4 },
  { code: 'CHF', name: 'Швейцарський франк', exponent: 2, sortOrder: 5 },
  { code: 'CAD', name: 'Канадський долар', exponent: 2, sortOrder: 6 },
  { code: 'CZK', name: 'Чеська крона', exponent: 2, sortOrder: 7 },
  { code: 'SEK', name: 'Шведська крона', exponent: 2, sortOrder: 8 },
]

// Пошта зберігається в нижньому регістрі: domain/auth.ts нормалізує ввід через
// toLowerCase() і шукає користувача саме так. Запис «Admin@gmail.com» як є
// створив би акаунт, у який неможливо увійти.
const ADMIN = {
  email: 'admin@gmail.com',
  displayName: 'Admin',
  capabilities: ['invest', 'borrow'],
  isAdmin: true,
  password: process.env.SEED_ADMIN_PASSWORD ?? 'Admin123',
}

async function main() {
  await db
    .insert(currencies)
    .values(CURRENCIES)
    .onConflictDoUpdate({
      target: currencies.code,
      set: { name: sql`excluded.name`, exponent: sql`excluded.exponent` },
    })

  // `external` is the live feed and the default source, so it must be active
  // after a seed — otherwise the first refresh has no row to attach rates to.
  await db
    .insert(rateSources)
    .values([
      { id: 'external', name: 'Rate aggregator (Ф7)', priority: 10, isActive: true },
      { id: 'hardcoded', name: 'Hardcoded fallback (Ф2)', priority: 100, isActive: false },
    ])
    .onConflictDoUpdate({
      target: rateSources.id,
      set: { name: sql`excluded.name`, isActive: sql`excluded.is_active` },
    })

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

  // Адмін — лише перший раз. Наявність будь-якого адміна означає, що система
  // вже комусь належить, і сід у це не втручається.
  const [existingAdmin] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isAdmin, true), isNull(users.deletedAt)))
    .limit(1)

  if (existingAdmin) {
    console.log('Адмін уже є — акаунт не чіпаємо.')
  } else {
    const { password, ...person } = ADMIN
    const passwordHash = await hash(password)
    const [admin] = await db
      .insert(users)
      .values({ id: newId('usr'), passwordHash, ...person })
      .onConflictDoUpdate({
        target: users.email,
        set: { passwordHash, isAdmin: true, deletedAt: null },
      })
      .returning()

    // Рахунки під кожну валюту заводяться одразу: інакше перше поповнення
    // впиралося б у відсутній рахунок замість того, щоб просто пройти.
    for (const currency of CURRENCIES) await userWallet(admin!.id, currency.code)
    console.log(`Створено адміна ${ADMIN.email}`)
  }

  await refreshRates(console)

  console.log('Seed done.')
}

await main()
await pool.end()
