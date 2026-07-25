import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { currencies, exchangeRates, fxQuotes } from '../../db/schema/index.ts'
import { config } from '../config.ts'
import { errors } from '../errors.ts'
import { divFloor, newId, parseAmount } from '../money/amount.ts'
import { postTransaction } from '../money/ledger.ts'
import { platformFx, userWallet } from '../money/accounts.ts'
import type { DbOrTx, Money, Tx } from '../types.ts'

export type ExchangeRate = typeof exchangeRates.$inferSelect
export type FxQuote = typeof fxQuotes.$inferSelect

// Rates are integers scaled by 1e6: 41.20 → 41_200_000. Same rule as money —
// no floating point anywhere on the path to a balance.
export const RATE_SCALE = 1_000_000n

export function parseRate(text: string | number): bigint {
  const [whole, frac = ''] = String(text).trim().split('.')
  if (!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac))) {
    throw new Error(`bad rate "${text}"`)
  }
  return BigInt(whole + frac.slice(0, 6).padEnd(6, '0'))
}

export const formatRate = (value: bigint): string => {
  const text = value.toString().padStart(7, '0')
  return `${text.slice(0, -6)}.${text.slice(-6)}`
}

const pow10 = (n: number) => 10n ** BigInt(n)

/** Newest quote per currency, plus staleness — the UI shows a badge for it. */
export async function currentRates(
  tx: DbOrTx = db,
): Promise<Array<ExchangeRate & { isStale: boolean }>> {
  const rows = await tx
    .select()
    .from(exchangeRates)
    .where(eq(exchangeRates.base, config.baseCurrency))
    .orderBy(desc(exchangeRates.observedAt))

  const newest = new Map<string, ExchangeRate>()
  for (const row of rows) if (!newest.has(row.quote)) newest.set(row.quote, row)

  const staleAfter = config.fx.staleAfterMinutes * 60 * 1000
  return [...newest.values()].map((row) => ({
    ...row,
    isStale: Date.now() - new Date(row.observedAt).getTime() > staleAfter,
  }))
}

async function rateFor(code: string, tx: DbOrTx = db): Promise<ExchangeRate> {
  const [row] = await tx
    .select()
    .from(exchangeRates)
    .where(and(eq(exchangeRates.base, config.baseCurrency), eq(exchangeRates.quote, code)))
    .orderBy(desc(exchangeRates.observedAt))
    .limit(1)
  if (!row) throw errors.rateStale()
  return row
}

async function exponents(tx: DbOrTx = db): Promise<Map<string, number>> {
  const rows = await tx.select().from(currencies)
  return new Map(rows.map((c) => [c.code, c.exponent]))
}

/**
 * Convert minor units of `from` into minor units of `to`, given a UAH-quoted
 * rate. Always rounds down for the user (PLATFORM_PLAN §3.2): the remainder
 * stays on platform_fx rather than being conjured out of nothing.
 */
export function convertMinor({
  amount,
  rate,
  direction,
  expFrom,
  expTo,
}: {
  amount: Money
  rate: bigint
  direction: 'to_base' | 'from_base'
  expFrom: number
  expTo: number
}): Money {
  if (direction === 'to_base') {
    // amount × rate, adjusted for differing exponents.
    const numerator = amount * rate * pow10(Math.max(expTo - expFrom, 0))
    const denominator = RATE_SCALE * pow10(Math.max(expFrom - expTo, 0))
    return divFloor(numerator, denominator)
  }
  // from_base: amount ÷ rate
  const numerator = amount * RATE_SCALE * pow10(Math.max(expTo - expFrom, 0))
  const denominator = rate * pow10(Math.max(expFrom - expTo, 0))
  return divFloor(numerator, denominator)
}

/**
 * Quote-lock. The user sees exact amounts and a TTL; execute() then works off
 * this row, so "the rate moved while I was clicking" cannot happen.
 * A cross pair (USD→EUR) is routed through UAH: sell side out, buy side in.
 */
export async function quote({
  userId,
  from,
  to,
  amountFrom,
}: {
  userId: string
  from: string
  to: string
  amountFrom: string
}): Promise<FxQuote> {
  if (from === to) throw errors.validation('Оберіть різні валюти', { to: 'та сама валюта' })
  const value = parseAmount(amountFrom, { field: 'amountFrom' })
  if (value <= 0n) throw errors.validation('Сума має бути більшою за нуль', { amountFrom: 'мін. 0.01' })

  const exp = await exponents()
  if (!exp.has(from) || !exp.has(to)) throw errors.notFound('Валюту')

  const base = config.baseCurrency
  let amountTo: Money
  let rateUsed: bigint
  let side: string
  let rateId: string | null = null

  if (from === base) {
    const rate = await rateFor(to)
    ensureFresh(rate)
    // User buys `to` → platform SELLS it.
    amountTo = convertMinor({
      amount: value,
      rate: rate.sell,
      direction: 'from_base',
      expFrom: exp.get(from)!,
      expTo: exp.get(to)!,
    })
    rateUsed = rate.sell
    side = 'sell'
    rateId = rate.id
  } else if (to === base) {
    const rate = await rateFor(from)
    ensureFresh(rate)
    // User sells `from` → platform BUYS it at bid.
    amountTo = convertMinor({
      amount: value,
      rate: rate.bid,
      direction: 'to_base',
      expFrom: exp.get(from)!,
      expTo: exp.get(to)!,
    })
    rateUsed = rate.bid
    side = 'bid'
    rateId = rate.id
  } else {
    const sellLeg = await rateFor(from)
    const buyLeg = await rateFor(to)
    ensureFresh(sellLeg)
    ensureFresh(buyLeg)
    const viaBase = convertMinor({
      amount: value,
      rate: sellLeg.bid,
      direction: 'to_base',
      expFrom: exp.get(from)!,
      expTo: exp.get(base)!,
    })
    amountTo = convertMinor({
      amount: viaBase,
      rate: buyLeg.sell,
      direction: 'from_base',
      expFrom: exp.get(base)!,
      expTo: exp.get(to)!,
    })
    // Effective cross rate, reported for transparency.
    rateUsed = value > 0n ? divFloor(sellLeg.bid * RATE_SCALE, buyLeg.sell) : 0n
    side = 'cross'
    rateId = sellLeg.id
  }

  if (amountTo <= 0n) {
    throw errors.validation('Сума замала для конвертації', { amountFrom: 'збільште суму' })
  }

  const expiresAt = new Date(Date.now() + config.fx.quoteTtlSeconds * 1000)
  const [row] = await db
    .insert(fxQuotes)
    .values({
      id: newId('fxq'),
      userId,
      fromCurrency: from,
      toCurrency: to,
      amountFrom: value,
      amountTo,
      rateUsed,
      side,
      rateId,
      expiresAt,
    })
    .returning()
  return row
}

function ensureFresh(rate: ExchangeRate): void {
  const staleAfter = config.fx.staleAfterMinutes * 60 * 1000
  if (Date.now() - new Date(rate.observedAt).getTime() > staleAfter) throw errors.rateStale()
}

/**
 * Execute a quote: four entries, all in one transaction. The platform's FX
 * result is the spread that settles on the platform_fx pair — no separate fee
 * entry (PLATFORM_PLAN §3.2).
 */
export async function execute({
  userId,
  quoteId,
  idempotencyKey,
}: {
  userId: string
  quoteId: string
  idempotencyKey?: string | null
}): Promise<{ transactionId: string; replayed: boolean }> {
  return db.transaction(async (tx) => {
    // Lock the quote so two parallel executes cannot both consume it.
    const locked = await tx.execute(
      sql`SELECT * FROM ${fxQuotes} WHERE id = ${quoteId} FOR UPDATE`,
    )
    const row = (locked.rows ?? locked)[0] as Record<string, any> | undefined
    if (!row || row.user_id !== userId) throw errors.notFound('Котирування')
    if (row.consumed_by_tx) {
      // A retry of a completed execute: return what it produced the first time.
      return { transactionId: row.consumed_by_tx, replayed: true }
    }
    if (new Date(row.expires_at).getTime() < Date.now()) throw errors.quoteExpired()

    const from = row.from_currency
    const to = row.to_currency
    const amountFrom = BigInt(row.amount_from)
    const amountTo = BigInt(row.amount_to)

    const fromWallet = await userWallet(userId, from, tx)
    const toWallet = await userWallet(userId, to, tx)
    const fxFrom = await platformFx(from, tx)
    const fxTo = await platformFx(to, tx)

    const posted = await postTransaction(
      {
        type: 'fx',
        idempotencyKey,
        actorId: userId,
        meta: { quoteId, rate: formatRate(BigInt(row.rate_used)), from, to },
        entries: [
          { accountId: fromWallet.id, currency: from, amount: -amountFrom, entryType: 'fx' },
          { accountId: fxFrom.id, currency: from, amount: amountFrom, entryType: 'fx' },
          { accountId: fxTo.id, currency: to, amount: -amountTo, entryType: 'fx' },
          { accountId: toWallet.id, currency: to, amount: amountTo, entryType: 'fx' },
        ],
      },
      tx,
    )

    await tx
      .update(fxQuotes)
      .set({ consumedByTx: posted.transactionId })
      .where(and(eq(fxQuotes.id, quoteId), isNull(fxQuotes.consumedByTx)))

    return posted
  })
}

/**
 * Store a provider's rates. Validation is not optional: `sell > bid > 0` and no
 * jump beyond FX_MAX_JUMP_BPS versus the last accepted value. A bad feed row is
 * logged and skipped, never applied (PLATFORM_PLAN §3.3).
 */
export async function ingestRates(
  rates: Array<{ code: string; bid: string; sell: string }>,
  { sourceId, log = console }: { sourceId: string; log?: Partial<Console> },
): Promise<ExchangeRate[]> {
  const accepted: ExchangeRate[] = []
  for (const raw of rates) {
    const bid = parseRate(raw.bid)
    const sell = parseRate(raw.sell)
    if (!(sell > bid && bid > 0n)) {
      log.warn?.({ code: raw.code, bid: raw.bid, sell: raw.sell }, 'fx: rejected — sell > bid > 0 violated')
      continue
    }

    const [previous] = await db
      .select()
      .from(exchangeRates)
      .where(
        and(eq(exchangeRates.base, config.baseCurrency), eq(exchangeRates.quote, raw.code)),
      )
      .orderBy(desc(exchangeRates.observedAt))
      .limit(1)

    if (previous) {
      const jump = (abs(sell - previous.sell) * 10000n) / previous.sell
      if (jump > BigInt(config.fx.maxJumpBps)) {
        log.warn?.(
          { code: raw.code, from: formatRate(previous.sell), to: formatRate(sell) },
          'fx: rejected — implausible jump, keeping previous rate',
        )
        continue
      }
    }

    const [inserted] = await db
      .insert(exchangeRates)
      .values({
        id: newId('rat'),
        sourceId,
        base: config.baseCurrency,
        quote: raw.code,
        bid,
        sell,
        observedAt: new Date(),
      })
      .returning()
    accepted.push(inserted)
  }
  return accepted
}

const abs = (v: bigint) => (v < 0n ? -v : v)
