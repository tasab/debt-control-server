import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { rateSources } from '../../db/schema/index.js'
import { config } from '../config.js'
import { hardcodedProvider } from './providers/hardcoded.js'
import { externalProvider } from './providers/external.js'
import { ingestRates } from './service.js'

/**
 * Rates are never read from a provider during an operation — this job pulls
 * them into exchange_rates and every operation reads our own database. That is
 * what makes conversions reproducible and outage-proof (PLATFORM_PLAN §3.1).
 */
export function providerFor(name = config.fx.source) {
  return name === 'external' ? externalProvider : hardcodedProvider
}

export async function refreshRates(log = console) {
  const provider = providerFor()
  const [source] = await db.select().from(rateSources).where(eq(rateSources.id, provider.name))
  if (!source) {
    log.warn?.({ provider: provider.name }, 'fx: no rate_source row, run the seed')
    return []
  }

  try {
    const rates = await provider.fetchRates()
    const accepted = await ingestRates(rates, { sourceId: source.id, log })
    log.info?.({ provider: provider.name, accepted: accepted.length }, 'fx: rates refreshed')
    return accepted
  } catch (err) {
    // Falling over leaves the last known rates in place; they are served with
    // isStale: true so the UI can say so rather than pretend.
    log.error?.({ err, provider: provider.name }, 'fx: refresh failed, keeping previous rates')
    return []
  }
}

export function startRateJob(log = console) {
  const interval = config.fx.refreshIntervalMinutes * 60 * 1000
  refreshRates(log)
  const timer = setInterval(() => refreshRates(log), interval)
  timer.unref()
  return timer
}
