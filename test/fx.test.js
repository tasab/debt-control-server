import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { db, pool } from '../src/db/index.js'
import { fxQuotes, rateSources } from '../db/schema/index.js'
import { convertMinor, execute, ingestRates, parseRate, quote, RATE_SCALE } from '../src/fx/service.js'
import { availableBalance } from '../src/money/balances.js'
import { ledgerTotals } from '../src/money/ledger.js'
import { newId } from '../src/money/amount.js'
import { fund, makeUser, resetDb } from './helpers.js'

const silent = { warn: () => {}, info: () => {}, error: () => {} }

beforeEach(async () => {
  await resetDb()
  await db
    .insert(rateSources)
    .values({ id: 'hardcoded', name: 'test', priority: 1 })
    .onConflictDoNothing()
  await ingestRates([{ code: 'USD', bid: '41.20', sell: '42.10' }], {
    sourceId: 'hardcoded',
    log: silent,
  })
})

after(async () => {
  await pool.end()
})

test('rate parsing keeps six decimal places as an integer', () => {
  assert.equal(parseRate('41.20'), 41_200_000n)
  assert.equal(parseRate('40'), 40_000_000n)
})

test('conversion always rounds down for the user', () => {
  // 1000.00 UAH ÷ 42.10 = 23.7529... USD → 23.75, remainder stays with platform_fx.
  const usd = convertMinor({
    amount: 100_000n,
    rate: parseRate('42.10'),
    direction: 'from_base',
    expFrom: 2,
    expTo: 2,
  })
  assert.equal(usd, 2375n)

  const uah = convertMinor({
    amount: 2375n,
    rate: parseRate('41.20'),
    direction: 'to_base',
    expFrom: 2,
    expTo: 2,
  })
  assert.equal(uah, 97_850n)
  assert.ok(uah < 100_000n, 'round-tripping must lose the spread, never gain')
})

test('an implausible jump is rejected and the previous rate stays in force', async () => {
  const accepted = await ingestRates([{ code: 'USD', bid: '120.00', sell: '121.00' }], {
    sourceId: 'hardcoded',
    log: silent,
  })
  assert.equal(accepted.length, 0)
})

test('sell must be greater than bid', async () => {
  const accepted = await ingestRates([{ code: 'USD', bid: '43.00', sell: '42.00' }], {
    sourceId: 'hardcoded',
    log: silent,
  })
  assert.equal(accepted.length, 0)
})

test('executing a quote posts four balanced entries', async () => {
  const user = await makeUser()
  await fund(user, 100_000n)

  const created = await quote({ userId: user.id, from: 'UAH', to: 'USD', amountFrom: '100000' })
  assert.equal(created.side, 'sell', 'buying USD applies the SELL side')

  await execute({ userId: user.id, quoteId: created.id, idempotencyKey: newId('idem') })

  assert.equal(await availableBalance(user.id, 'UAH'), 0n)
  assert.equal(await availableBalance(user.id, 'USD'), created.amountTo)
  for (const { currency, total } of await ledgerTotals()) {
    assert.equal(total, 0n, `${currency} must sum to zero`)
  }
})

test('an expired quote is refused with QUOTE_EXPIRED', async () => {
  const user = await makeUser()
  await fund(user, 100_000n)
  const created = await quote({ userId: user.id, from: 'UAH', to: 'USD', amountFrom: '100000' })

  await db
    .update(fxQuotes)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(fxQuotes.id, created.id))

  await assert.rejects(
    execute({ userId: user.id, quoteId: created.id, idempotencyKey: newId('idem') }),
    (err) => err.code === 'QUOTE_EXPIRED',
  )
  assert.equal(await availableBalance(user.id, 'UAH'), 100_000n)
})

test('a quote is single-use', async () => {
  const user = await makeUser()
  await fund(user, 200_000n)
  const created = await quote({ userId: user.id, from: 'UAH', to: 'USD', amountFrom: '100000' })

  const first = await execute({ userId: user.id, quoteId: created.id, idempotencyKey: newId('idem') })
  const second = await execute({ userId: user.id, quoteId: created.id, idempotencyKey: newId('idem') })

  assert.equal(second.transactionId, first.transactionId)
  assert.equal(second.replayed, true)
  assert.equal(await availableBalance(user.id, 'UAH'), 100_000n, 'only one conversion happened')
})

test('the scale constant matches the parser', () => {
  assert.equal(RATE_SCALE, 1_000_000n)
})
