import { accrueInterest } from '../domain/loans.ts'
import { settleExpiredRequests } from '../domain/requests.ts'
import { writeSnapshots } from '../domain/stats.ts'
import { startRateJob } from '../fx/job.ts'
import { reconcile } from './reconcile.ts'

const HOUR = 60 * 60 * 1000

/**
 * In-process schedulers. Fine for one instance; the moment there are two, these
 * move behind a lock or an external scheduler — every job here is written to be
 * safely re-runnable, which is what makes that switch cheap.
 */
type JobLogger = Partial<Console>

export function startJobs(log: JobLogger = console) {
  const timers: NodeJS.Timeout[] = []

  const every = (ms: number, name: string, fn: (log: JobLogger) => Promise<unknown>) => {
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
  every(6 * HOUR, 'accrual', (l: JobLogger) => accrueInterest(new Date(), l))
  every(HOUR, 'request-expiry', (l: JobLogger) => settleExpiredRequests(l))
  every(24 * HOUR, 'snapshots', (l: JobLogger) => writeSnapshots(new Date(), l))
  every(24 * HOUR, 'reconcile', (l: JobLogger) => reconcile(l))

  log.info?.('jobs: started')
  return timers
}
