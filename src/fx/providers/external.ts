import { config } from '../../config.ts'

/**
 * Ф7 provider. Same interface as hardcoded.js — if wiring a real feed ever
 * requires touching anything outside this directory, the abstraction is wrong
 * (SERVER_PLAN §3, S7).
 *
 * The upstream contract is fixed by D6: `[{ CODE, BID, SELL }]`.
 */
export const externalProvider = {
  name: 'external',
  async fetchRates() {
    const url = process.env.RATE_API_URL
    if (!url) throw new Error('RATE_API_URL is not set but RATE_SOURCE=external')

    const response = await fetch(url, {
      headers: process.env.RATE_API_KEY ? { authorization: `Bearer ${process.env.RATE_API_KEY}` } : {},
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`rate provider responded ${response.status}`)

    const payload = await response.json()
    const list: Array<Record<string, unknown>> = Array.isArray(payload)
      ? payload
      : ((payload as { rates?: Array<Record<string, unknown>> }).rates ?? [])

    return list.map((row) => ({
      code: String(row.CODE ?? row.code).toUpperCase(),
      bid: String(row.BID ?? row.bid),
      sell: String(row.SELL ?? row.sell),
    }))
  },
}

export function selectProvider(name: string = config.fx.source) {
  return name === 'external' ? externalProvider : null
}
