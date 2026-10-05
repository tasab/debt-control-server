import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { currencies } from '../../db/schema/index.ts'
import { config } from '../config.ts'
import { errors } from '../errors.ts'
import { currentRates, MANUAL_SOURCE, RATE_SCALE } from '../fx/service.ts'
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
    pivot,
    mid,
    exponent,
    staleCodes: rates.filter((r) => r.isStale).map((r) => r.quote),
  }
}

/**
 * Середній курс `currency` до півота, що діяв у момент `at`, — SQL-вираз для
 * підзапиту в SELECT.
 *
 * Курси — історія, а не поточне значення: рядки лише додаються, тож «який
 * курс був минулого вівторка» має одну відповідь і завтра не зміниться. Ручний
 * курс, як і в `currentRates`, перекриває стрічку — але лише той, що вже був
 * виставлений на той момент. Якщо операція старша за всю історію курсів,
 * береться найперший відомий: нічого точнішого немає.
 */
export const midAtSql = (currency: SQL, at: SQL) => sql`(
  SELECT (r.bid + r.sell) / 2 FROM exchange_rates r
  WHERE r.base = ${config.baseCurrency} AND r.quote = ${currency}
  ORDER BY (r.observed_at <= ${at}) DESC,
           CASE WHEN r.observed_at <= ${at} THEN r.source_id = ${MANUAL_SOURCE} END DESC,
           CASE WHEN r.observed_at <= ${at} THEN r.observed_at END DESC,
           r.observed_at ASC
  LIMIT 1)`

/**
 * Мінорні одиниці `currency` → мінорні одиниці півота за вже знайденим курсом.
 *
 * Округлення симетричне (до нуля за модулем), а не вниз: рух і його
 * скасування мають дати рівно протилежні суми, інакше скасований внесок
 * лишав би по копійці в капіталі.
 */
export function pivotAt(
  amount: Money,
  currency: string,
  mid: bigint | null,
  exponent: Map<string, number>,
): Money {
  if (currency === config.baseCurrency) return amount
  if (!mid) return 0n
  const magnitude = amount < 0n ? -amount : amount
  const value =
    (magnitude * mid * 10n ** BigInt(exponent.get(config.baseCurrency) ?? 2)) /
    (RATE_SCALE * 10n ** BigInt(exponent.get(currency) ?? 2))
  return amount < 0n ? -value : value
}
