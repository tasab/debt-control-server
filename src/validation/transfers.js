import { z } from 'zod'
import { amountString, comment, currencyCode } from './common.js'

export const transferSchema = z.object({
  toUserId: z.string().min(1),
  currency: currencyCode,
  amount: amountString,
  comment,
})

export const feePreviewSchema = z.object({
  kind: z.enum(['transfer', 'interest_share', 'origination']).default('transfer'),
  currency: currencyCode,
  amount: amountString,
})

export const topUpSchema = z.object({
  userId: z.string().min(1),
  currency: currencyCode,
  amount: amountString,
  comment,
})
