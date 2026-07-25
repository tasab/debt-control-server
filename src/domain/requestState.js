import { and, eq } from 'drizzle-orm'
import { fundingRequests } from '../../db/schema/index.js'
import { errors } from '../errors.js'

/**
 * The request state machine (PLATFORM_PLAN §6.2), in one place. Routes never
 * set `status` directly — they call `transition`, so an illegal move is
 * impossible rather than merely unlikely.
 *
 *   draft → open → funded → disbursed
 *             ↘ expired / cancelled   (holds returned)
 */
export const TRANSITIONS = {
  draft: ['open', 'cancelled'],
  open: ['funded', 'expired', 'cancelled'],
  funded: ['disbursed'],
  disbursed: [],
  expired: [],
  cancelled: [],
}

export const canTransition = (from, to) => (TRANSITIONS[from] ?? []).includes(to)

export async function transition(tx, request, to, patch = {}) {
  if (!canTransition(request.status, to)) {
    throw errors.conflict(
      'INVALID_TRANSITION',
      `Заявку не можна перевести з «${request.status}» у «${to}»`,
    )
  }
  // The WHERE clause repeats the expected status, so a concurrent transition
  // loses here instead of overwriting the winner.
  const [updated] = await tx
    .update(fundingRequests)
    .set({ status: to, ...patch })
    .where(and(eq(fundingRequests.id, request.id), eq(fundingRequests.status, request.status)))
    .returning()
  if (!updated) throw errors.conflict('INVALID_TRANSITION', 'Стан заявки змінився, оновіть сторінку')
  return updated
}
