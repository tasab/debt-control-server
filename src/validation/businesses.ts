import { z } from 'zod'
import { amountString, currencyCode, isoDate } from './common.ts'

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

// Перерахунок. `amountString` тут — це порахований залишок, а не рух, тож
// нуль допустимий: «каса порожня» — теж результат перерахунку.
const countedAmount = z.string().regex(/^\d+$/, 'некоректна сума')

export const cashCountSchema = z
  .object({
    registers: z
      .array(z.object({ registerId: z.string().min(1), amount: countedAmount }))
      .default([]),
    cash: z.array(z.object({ currency: currencyCode, amount: countedAmount })).default([]),
    note: z.string().trim().max(280).optional(),
    countedAt: isoDate.optional(),
  })
  .refine((v) => v.registers.length > 0 || v.cash.length > 0, {
    message: 'Вкажіть хоча б один залишок',
    path: ['registers'],
  })

// Витрата або вилучення. Причина обов'язкова: через півроку «−50 000» без
// пояснення не скаже нічого, а саме ці рядки складають місячний звіт.
export const spendingSchema = z.object({
  kind: z.enum(['expense', 'draw', 'capital']),
  source: z.string().regex(/^(cash|income|register:.+)$/, 'оберіть джерело'),
  currency: currencyCode,
  amount: amountString,
  comment: z.string({ error: 'вкажіть причину' }).trim().min(3, 'вкажіть причину').max(280),
})

export const monthlyQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(60).default(12),
  in: currencyCode.optional(),
})

// Валюта показу дашборда. Порожнє значення = базова валюта сервера.
export const dashboardQuerySchema = z.object({ in: currencyCode.optional() })

// Endpoints: 'owner' (the owner's personal wallet), 'business', or
// 'register:<id>'. Validated as a shape here; existence is checked in the domain.
export const internalTransferSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  currency: currencyCode,
  amount: amountString,
  comment: z.string().trim().max(280).optional(),
})
