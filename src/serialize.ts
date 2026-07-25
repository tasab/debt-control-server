import { serializeAmount } from './money/amount.ts'
import type { Money } from './types.ts'

// The HTTP boundary. Amounts leave as strings of minor units, dates as ISO-8601
// UTC (SERVER_PLAN §2.1). Nothing below this line is a BigInt or a Date.
export const money = serializeAmount
export const iso = (date: Date | string | null | undefined): string | null => (date ? new Date(date).toISOString() : null)

export const serializeUser = (user: Record<string, any>, extra: Record<string, unknown> = {}) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  capabilities: user.capabilities,
  isAdmin: user.isAdmin ?? false,
  ...extra,
})

export const serializeCurrency = (c: Record<string, any>) => ({
  code: c.code,
  name: c.name,
  exponent: c.exponent,
  isActive: c.isActive,
  isBase: c.isBase,
})

export const serializeWallet = (w: { currency: string; available: Money; held: Money; total: Money }) => ({
  currency: w.currency,
  available: money(w.available),
  held: money(w.held),
  total: money(w.total),
})

/**
 * Opaque cursor over (createdAt, id) — opaque so the shape can change without
 * breaking clients that stored one.
 */
export const encodeCursor = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

export const decodeCursor = (cursor?: string | null): any => {
  if (!cursor) return null
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}
