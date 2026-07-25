import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db/index.ts'
import { buildServer } from '../src/index.ts'
import { newId } from '../src/money/amount.ts'
import { resetDb, seedFeePolicy } from './helpers.ts'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'

let app: FastifyInstance

before(async () => {
  await resetDb()
  await seedFeePolicy()
  app = await buildServer({ logger: false })
  await app.ready()
})

after(async () => {
  await app.close()
  await pool.end()
})

// inject() returns set-cookie as a string for one cookie, an array for several.
const rawCookie = (response: LightMyRequestResponse): string => [response.headers['set-cookie']].flat()[0] ?? ''
const cookieOf = (response: LightMyRequestResponse): string => rawCookie(response).split(';')[0]

async function registerUser(capability: 'invest' | 'borrow' = 'invest') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `${newId('e')}@test.local`,
      password: 'password123',
      displayName: 'Тестовий Користувач',
      capability,
    },
  })
  assert.equal(response.statusCode, 201, response.body)
  return { body: response.json(), cookie: cookieOf(response) }
}

test('register → me → wallets, with the session in an httpOnly cookie', async () => {
  const { body, cookie } = await registerUser()
  assert.deepEqual(body.capabilities, ['invest'])
  assert.equal(body.businessId, null)

  const raw = rawCookie(
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: `${newId('e')}@test.local`,
        password: 'password123',
        displayName: 'Ще Один',
        capability: 'invest',
      },
    }),
  )
  assert.match(raw, /HttpOnly/i, 'the session cookie must not be readable from JS')

  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().id, body.id)

  const wallets = await app.inject({ method: 'GET', url: '/api/wallets', headers: { cookie } })
  assert.equal(wallets.statusCode, 200)
  const uah = wallets.json().find((w: { currency: string }) => w.currency === 'UAH')
  // Amounts are strings of minor units on the wire, never numbers.
  assert.equal(typeof uah.available, 'string')
  assert.equal(uah.available, '0')
})

test('an unauthenticated request gets 401 in the standard error shape', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/wallets' })
  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'UNAUTHORIZED')
})

test('capabilities are enforced on the server, not in the UI', async () => {
  const { cookie } = await registerUser('invest')
  const response = await app.inject({
    method: 'POST',
    url: '/api/businesses',
    headers: { cookie },
    payload: { name: 'Спроба', baseCurrency: 'UAH' },
  })
  assert.equal(response.statusCode, 403)
  assert.equal(response.json().error.code, 'FORBIDDEN_CAPABILITY')
})

test('a non-admin cannot mint money', async () => {
  const { cookie, body } = await registerUser()
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/topups',
    headers: { cookie },
    payload: { userId: body.id, currency: 'UAH', amount: '100000' },
  })
  assert.equal(response.statusCode, 403)
})

test('fee preview tells the sender the total before they confirm', async () => {
  const { cookie } = await registerUser()
  const response = await app.inject({
    method: 'GET',
    url: '/api/fees/preview?kind=transfer&currency=UAH&amount=100000',
    headers: { cookie },
  })
  assert.equal(response.statusCode, 200)
  const preview = response.json()
  assert.equal(preview.amount, '100000')
  assert.equal(preview.fee, '500') // 0.5%
  assert.equal(preview.total, '100500')
  assert.equal(preview.payer, 'sender')
})

test('a transfer moves money and shows up in both histories', async () => {
  const admin = await registerUser('invest')
  // Promote to admin directly: there is no self-service path to admin, by design.
  const { db } = await import('../src/db/index.ts')
  const { users } = await import('../db/schema/index.ts')
  const { eq } = await import('drizzle-orm')
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.body.id))

  const sender = await registerUser('invest')
  const recipient = await registerUser('invest')

  await app.inject({
    method: 'POST',
    url: '/api/admin/topups',
    headers: { cookie: admin.cookie },
    payload: { userId: sender.body.id, currency: 'UAH', amount: '1000000' },
  })

  const key = crypto.randomUUID()
  const first = await app.inject({
    method: 'POST',
    url: '/api/transfers',
    headers: { cookie: sender.cookie, 'idempotency-key': key },
    payload: { toUserId: recipient.body.id, currency: 'UAH', amount: '100000', comment: 'за оренду' },
  })
  assert.equal(first.statusCode, 201, first.body)

  // Double-click: same key, no second transfer.
  const second = await app.inject({
    method: 'POST',
    url: '/api/transfers',
    headers: { cookie: sender.cookie, 'idempotency-key': key },
    payload: { toUserId: recipient.body.id, currency: 'UAH', amount: '100000', comment: 'за оренду' },
  })
  assert.equal(second.json().transactionId, first.json().transactionId)

  const recipientWallets = await app.inject({
    method: 'GET',
    url: '/api/wallets',
    headers: { cookie: recipient.cookie },
  })
  assert.equal(recipientWallets.json().find((w: { currency: string }) => w.currency === 'UAH').available, '100000')

  const history = await app.inject({
    method: 'GET',
    url: '/api/transactions?currency=UAH&search=оренду',
    headers: { cookie: sender.cookie },
  })
  const items = history.json().items
  assert.equal(items.length, 1)
  assert.equal(items[0].type, 'transfer_out')
  assert.equal(items[0].amount, '-100500', 'the fee is part of what the sender paid')
  assert.equal(items[0].counterparty.id, recipient.body.id)
})

test('logout revokes the session immediately', async () => {
  const { cookie } = await registerUser()
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })
  const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
  assert.equal(after.statusCode, 401)
})
