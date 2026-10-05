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

// Правка боргу перед учасником самим власником — та сама форма, що в адмінці:
// `set` може назвати нуль (обнулити борг), причина обов'язкова.
export const ownerAdjustSchema = z.object({
  currency: currencyCode,
  mode: z.enum(['set', 'credit', 'debit']),
  amount: z.string().regex(/^\d+$/, 'сума має бути рядком мінорних одиниць, напр. "100500"'),
  comment: z.string().trim().min(3, 'вкажіть причину').max(280, 'до 280 символів'),
})
