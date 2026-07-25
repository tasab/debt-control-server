/**
 * Phase-1 rate provider (PLATFORM_PLAN §3.3). Returns exactly the shape the
 * future external API will return — `{ code, bid, sell }` with major-unit
 * decimal strings — so switching to it is a config change, not a code change.
 *
 * bid  = platform BUYS this currency for UAH (user sells at this price)
 * sell = platform SELLS this currency for UAH (user buys at this price)
 */
const RATES = [
  { code: 'USD', bid: '41.20', sell: '42.10' },
  { code: 'EUR', bid: '44.60', sell: '45.60' },
  { code: 'GBP', bid: '52.30', sell: '53.50' },
  { code: 'PLN', bid: '10.35', sell: '10.75' },
]

export const hardcodedProvider = {
  name: 'hardcoded',
  async fetchRates() {
    // Small jitter is deliberately absent: a fixed feed makes tests and demos
    // reproducible. The external provider is where movement comes from.
    return RATES.map((r) => ({ ...r }))
  },
}
