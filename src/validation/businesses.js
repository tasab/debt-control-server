import { z } from 'zod'
import { amountString, currencyCode } from './common.js'

export const createBusinessSchema = z.object({
  name: z.string().trim().min(2, 'мінімум 2 символи').max(120),
  description: z.string().trim().max(1000).optional(),
  baseCurrency: currencyCode.default('UAH'),
  startingCapital: z
    .object({ amount: amountString, currency: currencyCode })
    .optional(),
})

export const startingCapitalSchema = z.object({
  amount: amountString,
  currency: currencyCode,
})

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'вкажіть назву').max(80),
  currency: currencyCode,
})

export const registerPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  isActive: z.boolean().optional(),
})

// Endpoints: 'owner' (the owner's personal wallet), 'business', or
// 'register:<id>'. Validated as a shape here; existence is checked in the domain.
export const internalTransferSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  currency: currencyCode,
  amount: amountString,
  comment: z.string().trim().max(280).optional(),
})
