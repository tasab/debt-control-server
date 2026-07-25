import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { db, pool } from '../src/db/index.ts'
import { postTransaction, ledgerTotals, computeBalance } from '../src/money/ledger.ts'
import { availableBalance } from '../src/money/balances.ts'
import { externalAccount, userWallet } from '../src/money/accounts.ts'
import { newId } from '../src/money/amount.ts'
import { transfer, topUp } from '../src/domain/transfers.ts'
import { fund, makeUser, resetDb, seedFeePolicy } from './helpers.ts'

before(async () => {
  await resetDb()
})

beforeEach(async () => {
  await resetDb()
})

after(async () => {
  await pool.end()
})

test('an unbalanced transaction is rejected', async () => {
  const user = await makeUser()
  const wallet = await userWallet(user.id, 'UAH')
  const external = await externalAccount('UAH')

  await assert.rejects(
    postTransaction({
      type: 'test',
      entries: [
        { accountId: external.id, currency: 'UAH', amount: -100n },
        { accountId: wallet.id, currency: 'UAH', amount: 99n },
      ],
    }),
    /does not balance/,
  )
  assert.equal(await computeBalance(wallet.id), 0n)
})

test('each currency must balance on its own, not in aggregate', async () => {
  const user = await makeUser()
  const uah = await userWallet(user.id, 'UAH')
  const usd = await userWallet(user.id, 'USD')

  // Sums to zero across both currencies, but neither currency balances.
  await assert.rejects(
    postTransaction({
      type: 'test',
      entries: [
        { accountId: uah.id, currency: 'UAH', amount: 100n },
        { accountId: usd.id, currency: 'USD', amount: -100n },
      ],
    }),
    /does not balance/,
  )
})

test('a wallet cannot go negative', async () => {
  const user = await makeUser()
  await fund(user, 1000n)
  const wallet = await userWallet(user.id, 'UAH')
  const external = await externalAccount('UAH')

  await assert.rejects(
    postTransaction({
      type: 'test',
      entries: [
        { accountId: wallet.id, currency: 'UAH', amount: -1001n },
        { accountId: external.id, currency: 'UAH', amount: 1001n },
      ],
    }),
    (err: any) => err.code === 'INSUFFICIENT_FUNDS',
  )
  assert.equal(await availableBalance(user.id, 'UAH'), 1000n)
})

test('100 concurrent debits cannot push a wallet below zero', async () => {
  const user = await makeUser()
  const recipient = await makeUser()
  await fund(user, 10_000n)
  await seedFeePolicy({ percentBps: 0, minAmount: 0n, maxAmount: 0n })

  // 100 × 200 = 20 000 attempted against a 10 000 balance.
  const attempts = Array.from({ length: 100 }, () =>
    transfer({
      fromUserId: user.id,
      toUserId: recipient.id,
      currency: 'UAH',
      amount: '200',
      idempotencyKey: newId('idem'),
    }).then(
      () => 'ok',
      (err: any) => err.code,
    ),
  )
  const results = await Promise.all(attempts)
  const succeeded = results.filter((r) => r === 'ok').length

  assert.equal(succeeded, 50, 'exactly half the debits should fit in the balance')
  assert.equal(await availableBalance(user.id, 'UAH'), 0n)
  assert.equal(await availableBalance(recipient.id, 'UAH'), 10_000n)
})

test('a repeated Idempotency-Key returns the original transaction, not a second one', async () => {
  const user = await makeUser()
  const recipient = await makeUser()
  await fund(user, 100_000n)
  await seedFeePolicy({ percentBps: 0, minAmount: 0n, maxAmount: 0n })

  const key = newId('idem')
  const first = await transfer({
    fromUserId: user.id,
    toUserId: recipient.id,
    currency: 'UAH',
    amount: '5000',
    idempotencyKey: key,
  })
  const second = await transfer({
    fromUserId: user.id,
    toUserId: recipient.id,
    currency: 'UAH',
    amount: '5000',
    idempotencyKey: key,
  })

  assert.equal(second.transactionId, first.transactionId)
  assert.equal(second.replayed, true)
  assert.equal(await availableBalance(recipient.id, 'UAH'), 5000n)
})

test('parallel requests sharing one Idempotency-Key post exactly once', async () => {
  const user = await makeUser()
  const recipient = await makeUser()
  await fund(user, 100_000n)
  await seedFeePolicy({ percentBps: 0, minAmount: 0n, maxAmount: 0n })

  const key = newId('idem')
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      transfer({
        fromUserId: user.id,
        toUserId: recipient.id,
        currency: 'UAH',
        amount: '5000',
        idempotencyKey: key,
      }),
    ),
  )
  const ids = new Set(results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<{ transactionId: string }>).value.transactionId))
  assert.equal(ids.size, 1, 'all winners must report the same transaction')
  assert.equal(await availableBalance(recipient.id, 'UAH'), 5000n)
})

test('the ledger sums to zero per currency after activity', async () => {
  const user = await makeUser()
  const recipient = await makeUser()
  await fund(user, 100_000n)
  await fund(user, 20_000n, 'USD')
  await seedFeePolicy()

  await transfer({
    fromUserId: user.id,
    toUserId: recipient.id,
    currency: 'UAH',
    amount: '30000',
    comment: 'за оренду',
    idempotencyKey: newId('idem'),
  })

  for (const { currency, total } of await ledgerTotals()) {
    assert.equal(total, 0n, `${currency} must sum to zero`)
  }
})

test('the database rejects an unbalanced insert even if the service is bypassed', async () => {
  const user = await makeUser()
  const wallet = await userWallet(user.id, 'UAH')

  await assert.rejects(
    db.transaction(async (tx) => {
      const txId = newId('txn')
      await tx.execute(
        sql`INSERT INTO transactions (id, type) VALUES (${txId}, 'hand-written')`,
      )
      await tx.execute(
        sql`INSERT INTO ledger_entries (id, transaction_id, account_id, currency, amount)
            VALUES (${newId('led')}, ${txId}, ${wallet.id}, 'UAH', 1000)`,
      )
    }),
    // Drizzle wraps the failure from COMMIT, so the trigger's message is on the cause.
    (err: any) => /does not balance/.test(err.cause?.message ?? err.message),
  )
})

test('a top-up is itself balanced: external goes negative by what the wallet gains', async () => {
  const admin = await makeUser({ isAdmin: true })
  const user = await makeUser()
  await topUp({
    adminId: admin.id,
    userId: user.id,
    currency: 'UAH',
    amount: '250000',
    idempotencyKey: newId('idem'),
  })

  const external = await externalAccount('UAH')
  assert.equal(await availableBalance(user.id, 'UAH'), 250_000n)
  assert.equal(await computeBalance(external.id), -250_000n)
})
