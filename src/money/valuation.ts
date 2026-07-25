import { db } from '../db/index.ts'
import { currencies } from '../../db/schema/index.ts'
import { config } from '../config.ts'
import { currentRates, RATE_SCALE } from '../fx/service.ts'
import { divFloor } from './amount.ts'
import type { DbOrTx, Money } from '../types.ts'

/**
 * Reporting-only valuation in the base currency (D8). Uses the **mid** rate
 * ((bid + sell) / 2) — never for a real operation, only for "what is this
 * portfolio worth in UAH". Real conversions always go through fx/service.js
 * with an explicit side.
 */
export async function valuationTable(tx: DbOrTx = db) {
  const [rates, currencyRows] = await Promise.all([
    currentRates(tx),
    tx.select().from(currencies),
  ])
  const exponent = new Map(currencyRows.map((c) => [c.code, c.exponent]))
  const mid = new Map(rates.map((r) => [r.quote, (r.bid + r.sell) / 2n]))
  const base = config.baseCurrency

  /** minor units of `currency` → minor units of the base currency. */
  const toBase = (amount: Money, currency: string): Money => {
    if (currency === base) return amount
    const rate = mid.get(currency)
    if (!rate) return 0n
    const expFrom = exponent.get(currency) ?? 2
    const expTo = exponent.get(base) ?? 2
    const numerator = amount * rate * 10n ** BigInt(Math.max(expTo - expFrom, 0))
    const denominator = RATE_SCALE * 10n ** BigInt(Math.max(expFrom - expTo, 0))
    return divFloor(numerator, denominator)
  }

  return { toBase, base, mid, exponent, staleCodes: rates.filter((r) => r.isStale).map((r) => r.quote) }
}
