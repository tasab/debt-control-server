import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { db, pool } from '../src/db/index.js'
import { businesses, loanShares, loans } from '../db/schema/index.js'
import { newId } from '../src/money/amount.js'
import { availableBalance, balanceOf } from '../src/money/balances.js'
import { ledgerTotals } from '../src/money/ledger.js'
import { businessWallet, platformFee, userHold } from '../src/money/accounts.js'
import { createRequest, cancelRequest, fundRequest } from '../src/domain/requests.js'
import { accrueInterest, repay } from '../src/domain/loans.js'
import { moveInternal } from '../src/domain/businesses.js'
import { fund, makeUser, resetDb, seedFeePolicy } from './helpers.js'

beforeEach(async () => {
  await resetDb()
})

after(async () => {
  await pool.end()
})

async function makeBusiness() {
  const owner = await makeUser({ capabilities: ['borrow'], name: 'Бізнес' })
  const [business] = await db
    .insert(businesses)
    .values({
      id: newId('biz'),
      ownerUserId: owner.id,
      name: 'Кав’ярня',
      baseCurrency: 'UAH',
    })
    .returning()
  return { owner, business }
}

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString()

test('funding freezes money in the investor hold, it does not leave their side', async () => {
  const { business } = await makeBusiness()
  const investor = await makeUser()
  await fund(investor, 1_000_000n)

  const request = await createRequest(business.id, {
    currency: 'UAH',
    amountTarget: '1000000',
    rateAnnualBps: 1800,
    termDays: 180,
    repaymentType: 'bullet',
    minTicket: '10000',
    expiresAt: tomorrow(),
  })

  await fundRequest({
    requestId: request.id,
    investorId: investor.id,
    amount: '400000',
    idempotencyKey: newId('idem'),
  })

  const hold = await userHold(investor.id, 'UAH')
  assert.equal(await availableBalance(investor.id, 'UAH'), 600_000n)
  assert.equal(await balanceOf(hold.id), 400_000n)
})

test('a cancelled request returns every hold', async () => {
  const { business } = await makeBusiness()
  const a = await makeUser()
  const b = await makeUser()
  await fund(a, 500_000n)
  await fund(b, 500_000n)

  const request = await createRequest(business.id, {
    currency: 'UAH',
    amountTarget: '1000000',
    rateAnnualBps: 1800,
    termDays: 180,
    repaymentType: 'bullet',
    expiresAt: tomorrow(),
  })
  for (const investor of [a, b]) {
    await fundRequest({
      requestId: request.id,
      investorId: investor.id,
      amount: '300000',
      idempotencyKey: newId('idem'),
    })
  }

  await cancelRequest({ requestId: request.id, businessId: business.id })

  assert.equal(await availableBalance(a.id, 'UAH'), 500_000n)
  assert.equal(await availableBalance(b.id, 'UAH'), 500_000n)
  assert.equal(await balanceOf((await userHold(a.id, 'UAH')).id), 0n)
})

test('overfunding and sub-minimum tickets are refused', async () => {
  const { business } = await makeBusiness()
  const investor = await makeUser()
  await fund(investor, 5_000_000n)

  const request = await createRequest(business.id, {
    currency: 'UAH',
    amountTarget: '1000000',
    rateAnnualBps: 1800,
    termDays: 180,
    repaymentType: 'bullet',
    minTicket: '100000',
    expiresAt: tomorrow(),
  })

  await assert.rejects(
    fundRequest({
      requestId: request.id,
      investorId: investor.id,
      amount: '50000',
      idempotencyKey: newId('idem'),
    }),
    (err) => err.code === 'BELOW_MIN_TICKET',
  )
  await assert.rejects(
    fundRequest({
      requestId: request.id,
      investorId: investor.id,
      amount: '1500000',
      idempotencyKey: newId('idem'),
    }),
    (err) => err.code === 'OVERFUNDED',
  )
})

test('full cycle: two investors → disbursement → repayment → closed, to the kopiyka', async () => {
  await seedFeePolicy({ kind: 'interest_share', percentBps: 1000, minAmount: null, maxAmount: null })
  const { owner, business } = await makeBusiness()
  const a = await makeUser({ name: 'Інвестор А' })
  const b = await makeUser({ name: 'Інвестор Б' })
  await fund(a, 1_000_000n)
  await fund(b, 1_000_000n)

  const request = await createRequest(business.id, {
    currency: 'UAH',
    amountTarget: '1000000',
    rateAnnualBps: 1800,
    termDays: 180,
    repaymentType: 'bullet',
    minTicket: '10000',
    expiresAt: tomorrow(),
  })

  await fundRequest({
    requestId: request.id,
    investorId: a.id,
    amount: '600000',
    idempotencyKey: newId('idem'),
  })
  const filled = await fundRequest({
    requestId: request.id,
    investorId: b.id,
    amount: '400000',
    idempotencyKey: newId('idem'),
  })
  assert.equal(filled.filled, true, 'reaching the target must disburse')

  const [loan] = await db.select().from(loans).where(eq(loans.businessId, business.id))
  assert.ok(loan, 'a loan exists after disbursement')
  assert.equal(loan.principal, 1_000_000n)

  // Σ share_bps === 10000 exactly (D4 / §6.5).
  const shares = await db.select().from(loanShares).where(eq(loanShares.loanId, loan.id))
  assert.equal(shares.reduce((acc, s) => acc + s.shareBps, 0), 10000)

  // Business received the principal; holds are gone.
  assert.equal(await balanceOf((await businessWallet(business.id, 'UAH')).id), 1_000_000n)
  assert.equal(await balanceOf((await userHold(a.id, 'UAH')).id), 0n)

  // Accrue a month of interest, then repay it in full.
  await db
    .update(loans)
    .set({ accruedThrough: new Date(Date.now() - 30 * 86_400_000) })
    .where(eq(loans.id, loan.id))
  await accrueInterest(new Date(), { info: () => {} })

  const [accrued] = await db.select().from(loans).where(eq(loans.id, loan.id))
  const interest = accrued.accruedInterest
  assert.ok(interest > 0n, 'interest accrued')

  const beforeA = await availableBalance(a.id, 'UAH')
  const beforeB = await availableBalance(b.id, 'UAH')
  const feeAccount = await platformFee('UAH')
  const feeBefore = await balanceOf(feeAccount.id)

  const result = await repay({
    loanId: loan.id,
    userId: owner.id,
    amount: interest.toString(),
    idempotencyKey: newId('idem'),
  })

  const gainedA = (await availableBalance(a.id, 'UAH')) - beforeA
  const gainedB = (await availableBalance(b.id, 'UAH')) - beforeB
  const feeTaken = (await balanceOf(feeAccount.id)) - feeBefore

  // What the investors received plus the platform's cut equals what the
  // business paid — exactly, with no kopiyka created or lost.
  assert.equal(gainedA + gainedB + feeTaken, interest)
  assert.equal(result.interest, interest)
  assert.equal(feeTaken, result.fee)

  // Repay the principal. The owner tops up their own wallet, then moves it into
  // the business wallet — repayments always come from the business side.
  await fund(owner, 1_000_000n)
  await moveInternal({
    userId: owner.id,
    businessId: business.id,
    from: 'owner',
    to: 'business',
    currency: 'UAH',
    amount: '1000000',
    idempotencyKey: newId('idem'),
  })
  const closing = await repay({
    loanId: loan.id,
    userId: owner.id,
    amount: '1000000',
    idempotencyKey: newId('idem'),
  })
  assert.equal(closing.closed, true)

  for (const { currency, total } of await ledgerTotals()) {
    assert.equal(total, 0n, `${currency} must still sum to zero`)
  }
})

test('two investors racing for the last slot cannot overfill the request', async () => {
  const { business } = await makeBusiness()
  const investors = await Promise.all([makeUser(), makeUser(), makeUser()])
  for (const investor of investors) await fund(investor, 1_000_000n)

  const request = await createRequest(business.id, {
    currency: 'UAH',
    amountTarget: '600000',
    rateAnnualBps: 1800,
    termDays: 180,
    repaymentType: 'bullet',
    minTicket: '100000',
    expiresAt: tomorrow(),
  })

  const results = await Promise.allSettled(
    investors.map((investor) =>
      fundRequest({
        requestId: request.id,
        investorId: investor.id,
        amount: '400000',
        idempotencyKey: newId('idem'),
      }),
    ),
  )
  const accepted = results.filter((r) => r.status === 'fulfilled').length
  assert.equal(accepted, 1, 'only one 400 000 ticket fits before the target is reached')
})
