import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { businesses, loans, repayments } from '../../db/schema/index.js'
/**
 * Business creditworthiness, 0–100, with the weights from PLATFORM_PLAN §7.
 * Returned as a letter grade plus the factor breakdown — a bare number invites
 * users to read it as a guarantee, which it is not (the UI shows a disclaimer).
 *
 * D2: the default penalty (−40 and quarantine) is deliberately absent until Ф6.
 */
export const WEIGHTS = {
  onTimePayments: 40,
  trackRecord: 20,
  tenure: 10,
  debtLoad: 15,
  verification: 15,
}

export function gradeOf(score) {
  if (score >= 80) return 'A'
  if (score >= 65) return 'B'
  if (score >= 45) return 'C'
  return 'D'
}

/** Rating for a user: their business rating if they have one, else null-ish. */
export async function ratingFor(userId) {
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.ownerUserId, userId))
    .limit(1)
  if (!business) return null
  const { score, grade } = await scoreBusiness(business)
  return { grade, score }
}

export async function scoreBusiness(business) {
  const businessLoans = await db.select().from(loans).where(eq(loans.businessId, business.id))
  const loanIds = businessLoans.map((l) => l.id)

  // 1. Share of payments made on time (40%). No history yet → neutral 70,
  //    so a new business is not indistinguishable from a bad one.
  let onTime = 0.7
  if (loanIds.length) {
    const [row] = await db
      .select({
        total: sql`COUNT(*)`,
        late: sql`COUNT(*) FILTER (WHERE ${repayments.status} = 'overdue'
                  OR (${repayments.paidAt} IS NOT NULL AND ${repayments.paidAt} > ${repayments.dueAt}))`,
      })
      .from(repayments)
      .where(
        sql`${repayments.loanId} IN (${sql.join(
          loanIds.map((id) => sql`${id}`),
          sql`, `,
        )}) AND (${repayments.status} <> 'due' OR ${repayments.dueAt} < now())`,
      )
    const total = Number(row?.total ?? 0)
    if (total > 0) onTime = 1 - Number(row.late) / total
  }

  // 2. Track record: closed loans and volume (20%). Saturates at 5 closed loans.
  const closed = businessLoans.filter((l) => l.status === 'closed').length
  const trackRecord = Math.min(closed / 5, 1)

  // 3. Tenure (10%): saturates at one year on the platform.
  const days = (Date.now() - new Date(business.createdAt).getTime()) / 86_400_000
  const tenure = Math.min(days / 365, 1)

  // 4. Debt load (15%): outstanding principal against wallet+register assets.
  //    Inverted — more leverage scores lower. Assets are read in the loan
  //    currency only; the cross-currency view lives in the dashboard.
  const outstanding = businessLoans
    .filter((l) => ['disbursed', 'repaying', 'overdue'].includes(l.status))
    .reduce((acc, l) => acc + l.outstandingPrincipal, 0n)
  let debtLoad = 1
  if (outstanding > 0n) {
    const assets = await businessAssetsRough(business.id)
    const ratio = assets > 0n ? Number(outstanding) / Number(assets) : 5
    debtLoad = Math.max(0, 1 - Math.min(ratio, 2) / 2)
  }

  // 5. Verification (15%): binary until documents exist as a feature.
  const verification = business.isVerified ? 1 : 0.3

  const factors = {
    onTimePayments: clamp01(onTime),
    trackRecord,
    tenure,
    debtLoad,
    verification,
  }
  const score = Math.round(
    Object.entries(WEIGHTS).reduce((acc, [key, weight]) => acc + factors[key] * weight, 0),
  )

  return {
    score,
    grade: gradeOf(score),
    factors: Object.fromEntries(
      Object.entries(factors).map(([key, value]) => [
        key,
        { value: Math.round(value * 100), weight: WEIGHTS[key] },
      ]),
    ),
  }
}

async function businessAssetsRough(businessId) {
  const rows = await db.execute(
    sql`SELECT COALESCE(SUM(b.balance), 0) AS total
        FROM accounts a LEFT JOIN account_balances b ON b.account_id = a.id
        WHERE a.owner_type = 'business' AND a.owner_id = ${businessId}`,
  )
  const value = (rows.rows ?? rows)[0]?.total ?? 0
  return BigInt(value)
}

const clamp01 = (v) => Math.min(Math.max(v, 0), 1)
