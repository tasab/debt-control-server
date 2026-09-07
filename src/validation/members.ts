import { z } from 'zod'
import { amountString, bps, comment, currencyCode } from './common.ts'

export const inviteSchema = z.object({ userId: z.string().min(1, 'оберіть користувача') })

// Ставку називає сам учасник, приймаючи запрошення. Нуль — звичайний випадок:
// безвідсотковий вклад, не пропущене поле.
export const acceptInviteSchema = z.object({ rateAnnualBps: bps.default(0) })

export const rateSchema = z.object({ rateAnnualBps: bps })

// Зняття: власник фізично видає готівку, додаток лише фіксує зменшення боргу.
// Коментар обов'язковий: сама проводка каже тільки «стало менше», а навіщо
// саме — не скаже ніхто, крім того, хто знімав, і то не через місяць.
export const withdrawSchema = z.object({
  currency: currencyCode,
  amount: amountString,
  comment: z.string({ error: 'вкажіть причину' }).trim().min(3, 'вкажіть причину').max(280, 'до 280 символів'),
})

export const claimTransferSchema = z.object({
  toUserId: z.string().min(1, 'оберіть отримувача'),
  currency: currencyCode,
  amount: amountString,
  comment,
})
