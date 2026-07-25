import { serializeAmount } from './money/amount.js'

// The HTTP boundary. Amounts leave as strings of minor units, dates as ISO-8601
// UTC (SERVER_PLAN §2.1). Nothing below this line is a BigInt or a Date.
export const money = serializeAmount
export const iso = (date) => (date ? new Date(date).toISOString() : null)

export const serializeUser = (user, extra = {}) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  capabilities: user.capabilities,
  isAdmin: user.isAdmin ?? false,
  ...extra,
})

export const serializeCurrency = (c) => ({
  code: c.code,
  name: c.name,
  exponent: c.exponent,
  isActive: c.isActive,
  isBase: c.isBase,
})

export const serializeWallet = (w) => ({
  currency: w.currency,
  available: money(w.available),
  held: money(w.held),
  total: money(w.total),
})

/**
 * Opaque cursor over (createdAt, id) — opaque so the shape can change without
 * breaking clients that stored one.
 */
export const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

export const decodeCursor = (cursor) => {
  if (!cursor) return null
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}
