import { config } from '../../config.ts'

/**
 * Ф7 provider — the live feed. Same interface as hardcoded.ts: if wiring a real
 * source ever requires touching anything outside this directory, the
 * abstraction is wrong (SERVER_PLAN §3, S7).
 *
 * The default upstream is the rate aggregator, which answers with
 * `{ rates: [{ code, bid, sell, prev }], rateInfo }` — codes lowercase, prices
 * as JSON numbers, quoted against UAH. The older `[{ CODE, BID, SELL }]` shape
 * is still accepted so a different URL can be pointed at RATE_API_URL.
 */
export const externalProvider = {
  name: 'external',
  async fetchRates() {
    const url = config.fx.apiUrl
    if (!url) throw new Error('RATE_API_URL is not set but RATE_SOURCE=external')

    const response = await fetch(url, {
      headers: process.env.RATE_API_KEY ? { authorization: `Bearer ${process.env.RATE_API_KEY}` } : {},
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`rate provider responded ${response.status}`)

    const payload = await response.json()
    return normalizeRates(payload)
  },
}

/**
 * Feed → `{ code, bid, sell }` with major-unit decimal strings.
 *
 * The aggregator can list the same code twice — the first row is the UAH quote,
 * a later one is a cross pair (EUR at 1.158 is EUR/USD, not EUR/UAH). Only the
 * first row per code is kept: everything downstream is quoted against UAH (D8),
 * and letting a cross rate through would silently mis-price a wallet.
 */
export function normalizeRates(payload: unknown): Array<{ code: string; bid: string; sell: string }> {
  const list: Array<Record<string, unknown>> = Array.isArray(payload)
    ? payload
    : ((payload as { rates?: Array<Record<string, unknown>> })?.rates ?? [])

  const seen = new Set<string>()
  const rates: Array<{ code: string; bid: string; sell: string }> = []
  for (const row of list) {
    const code = String(row.CODE ?? row.code ?? '').trim().toUpperCase()
    const bid = decimal(row.BID ?? row.bid)
    const sell = decimal(row.SELL ?? row.sell)
    if (!code || bid === null || sell === null || seen.has(code)) continue
    seen.add(code)
    rates.push({ code, bid, sell })
  }
  return rates
}

/**
 * JSON numbers arrive as `44.65`; parseRate wants a plain decimal string.
 * Exponential notation would parse as garbage, so it is rejected here rather
 * than turned into a wrong rate.
 */
function decimal(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return /^\d+(\.\d+)?$/.test(text) ? text : null
}
