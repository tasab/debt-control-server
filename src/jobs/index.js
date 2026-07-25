import { accrueInterest } from '../domain/loans.js'
import { settleExpiredRequests } from '../domain/requests.js'
import { writeSnapshots } from '../domain/stats.js'
import { startRateJob } from '../fx/job.js'
import { reconcile } from './reconcile.js'

const HOUR = 60 * 60 * 1000

/**
 * In-process schedulers. Fine for one instance; the moment there are two, these
 * move behind a lock or an external scheduler — every job here is written to be
 * safely re-runnable, which is what makes that switch cheap.
 */
export function startJobs(log = console) {
  const timers = []

  const every = (ms, name, fn) => {
    const run = async () => {
      try {
        await fn(log)
      } catch (err) {
        log.error?.({ err, job: name }, 'job failed')
      }
    }
    run()
    const timer = setInterval(run, ms)
    timer.unref()
    timers.push(timer)
  }

  timers.push(startRateJob(log))
  every(6 * HOUR, 'accrual', (l) => accrueInterest(new Date(), l))
  every(HOUR, 'request-expiry', (l) => settleExpiredRequests(l))
  every(24 * HOUR, 'snapshots', (l) => writeSnapshots(new Date(), l))
  every(24 * HOUR, 'reconcile', (l) => reconcile(l))

  log.info?.('jobs: started')
  return timers
}
