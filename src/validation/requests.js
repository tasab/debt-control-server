import { z } from 'zod'
import { amountString, currencyCode } from './common.js'

export const createRequestSchema = z.object({
  currency: currencyCode,
  amountTarget: amountString,
  // Basis points: 1800 = 18% annual. One format everywhere, so requests are
  // comparable (§6.4).
  rateAnnualBps: z.coerce.number().int().min(1).max(20000),
  termDays: z.coerce.number().int().min(7).max(3650),
  repaymentType: z.enum(['bullet', 'interest_only_flex']),
  minTicket: amountString.optional(),
  minFillBps: z.coerce.number().int().min(0).max(10000).optional(),
  purpose: z.string().trim().max(1000).optional(),
  expiresAt: z.string().datetime({ offset: true }),
})

export const listRequestsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  currency: currencyCode.optional(),
  minRate: z.coerce.number().int().optional(),
  maxTermDays: z.coerce.number().int().optional(),
  minGrade: z.enum(['A', 'B', 'C', 'D']).optional(),
  status: z.enum(['open', 'funded', 'disbursed', 'expired', 'cancelled']).default('open'),
})

export const fundSchema = z.object({ amount: amountString })

export const repaySchema = z.object({ amount: amountString })
