import { db } from '../db/index.ts'
import { currencies } from '../../db/schema/index.ts'
import { config } from '../config.ts'
import { errors } from '../errors.ts'
import { currentRates, RATE_SCALE } from '../fx/service.ts'
import { divFloor } from './amount.ts'
import type { DbOrTx, Money } from '../types.ts'

/**
 * Reporting-only valuation. Uses the **mid** rate ((bid + sell) / 2) — never
 * for a real operation, only for "what is this portfolio worth in X". Real
 * conversions always go through fx/service.js with an explicit side.
 *
 * Quotes are stored against one pivot currency (config.baseCurrency, D8), so
 * any pair converts through it. Passing `target` reports the same numbers in
 * another currency — that is the dashboard's UAH/USD switch, and it changes
 * nothing about how money is stored.
 */
export async function valuationTable(target?: string | null, tx: DbOrTx = db) {
  const [rates, currencyRows] = await Promise.all([
    currentRates(tx),
    tx.select().from(currencies),
  ])
  const exponent = new Map(currencyRows.map((c) => [c.code, c.exponent]))
  const mid = new Map(rates.map((r) => [r.quote, (r.bid + r.sell) / 2n]))
  const pivot = config.baseCurrency
  const base = target ?? pivot

  /** Price of one unit of `currency` in pivot terms, scaled by RATE_SCALE. */
  const rateOf = (currency: string): bigint | undefined =>
    currency === pivot ? RATE_SCALE : mid.get(currency)

  if (!rateOf(base)) throw errors.validation('Немає курсу для цієї валюти', { in: base })

  const pow10 = (n: number) => 10n ** BigInt(n)

  /**
   * Minor units of `from` → minor units of `to`, through the pivot in a single
   * expression so the intermediate value is never rounded twice.
   */
  const convert = (amount: Money, from: string, to: string): Money => {
    if (from === to) return amount
    const rateFrom = rateOf(from)
    const rateTo = rateOf(to)
    if (!rateFrom || !rateTo) return 0n
    const expFrom = exponent.get(from) ?? 2
    const expTo = exponent.get(to) ?? 2
    return divFloor(amount * rateFrom * pow10(expTo), rateTo * pow10(expFrom))
  }

  const toBase = (amount: Money, currency: string): Money => convert(amount, currency, base)

  return {
    toBase,
    convert,
    base,
    mid,
    exponent,
    staleCodes: rates.filter((r) => r.isStale).map((r) => r.quote),
  }
}
