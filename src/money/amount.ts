import { randomUUID } from 'node:crypto'
import type { Money, MoneyString } from '../types.ts'

// Everything money-shaped is a BigInt of minor units. This module is the only
// place that converts between that and anything else.

/** Wire → BigInt. Accepts "100500" (minor units) only; rejects floats outright. */
export function parseAmount(
  value: unknown,
  { field = 'amount' }: { field?: string } = {},
): Money {
  if (typeof value === 'bigint') return value
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new AmountError(`${field} must be a string of minor units, e.g. "100500"`, field)
  }
  return BigInt(value)
}

/** BigInt → wire. JSON has no bigint, so every amount leaves as a string. */
export function serializeAmount(value: Money | null | undefined): MoneyString {
  return (value ?? 0n).toString()
}

/** Human input ("1000.50") → minor units, given the currency exponent. */
export function fromMajor(input: string | number, exponent: number): Money {
  const text = String(input).trim().replace(',', '.').replace(/\s/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new AmountError(`"${input}" is not a number`)
  const negative = text.startsWith('-')
  const [whole, frac = ''] = text.replace('-', '').split('.')
  if (frac.length > exponent) throw new AmountError(`at most ${exponent} decimal places`)
  const scaled = BigInt(whole + frac.padEnd(exponent, '0'))
  return negative ? -scaled : scaled
}

/** Minor units → "1000.50". Used for error messages and CSV export only. */
export function toMajor(value: Money, exponent: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(exponent + 1, '0')
  const whole = digits.slice(0, digits.length - exponent)
  const frac = exponent ? '.' + digits.slice(digits.length - exponent) : ''
  return `${negative ? '-' : ''}${whole}${frac}`
}

export const abs = (v: Money): Money => (v < 0n ? -v : v)
export const max = (a: Money, b: Money): Money => (a > b ? a : b)
export const min = (a: Money, b: Money): Money => (a < b ? a : b)
export const sum = (values: Money[]): Money => values.reduce((acc, v) => acc + v, 0n)

/**
 * Percentage in basis points, rounded down. Rounding direction is never
 * implicit in this codebase — callers pick `applyBpsFloor` or `applyBpsCeil`
 * and the choice is visible at the call site.
 */
export function applyBpsFloor(value: Money, bps: number): Money {
  return divFloor(value * BigInt(bps), 10000n)
}

export function applyBpsCeil(value: Money, bps: number): Money {
  return divCeil(value * BigInt(bps), 10000n)
}

/** Floor division that behaves for negatives too (BigInt / truncates). */
export function divFloor(a: bigint, b: bigint): bigint {
  const q = a / b
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q
}

export function divCeil(a: bigint, b: bigint): bigint {
  const q = a / b
  return a % b !== 0n && a < 0n === b < 0n ? q + 1n : q
}

/**
 * Split `total` across weights so the parts sum to exactly `total`.
 * Every part is floored, then the rounding remainder goes to the largest
 * weight (ties broken by order) — deterministic, never invents a kopiyka.
 * This is the rule behind repayment distribution (PLATFORM_PLAN §6.5).
 */
export function splitProportionally(total: Money, weights: Array<number | bigint>): Money[] {
  const totalWeight = weights.reduce<bigint>((a, w) => a + BigInt(w), 0n)
  if (totalWeight <= 0n) throw new AmountError('cannot split across zero total weight')
  const parts: Money[] = weights.map((w) => divFloor(total * BigInt(w), totalWeight))
  let remainder = total - parts.reduce<bigint>((a, p) => a + p, 0n)
  if (remainder !== 0n) {
    let biggest = 0
    for (let i = 1; i < weights.length; i += 1) {
      if (BigInt(weights[i]!) > BigInt(weights[biggest]!)) biggest = i
    }
    parts[biggest] = parts[biggest]! + remainder
    remainder = 0n
  }
  return parts
}

/** Prefixed, sortable-enough ids: usr_…, txn_…, loan_… */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

export class AmountError extends Error {
  field: string | undefined

  constructor(message: string, field?: string) {
    super(message)
    this.name = 'AmountError'
    this.field = field
  }
}
