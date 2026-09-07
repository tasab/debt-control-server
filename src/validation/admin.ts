import { z } from 'zod'
import { currencyCode } from './common.ts'

// Unlike every other amount on the wire, an adjustment may name zero: `set: 0`
// empties an account, which is a legitimate edit. The domain still refuses a
// zero credit/debit — a move of nothing is not a correction.
const targetAmount = z
  .string()
  .regex(/^\d+$/, 'сума має бути рядком мінорних одиниць, напр. "100500"')

export const listParticipantsSchema = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const adjustBalanceSchema = z.object({
  currency: currencyCode,
  // Без нього правиться гаманець; із ним — борг бізнесу перед цим учасником.
  memberId: z.string().min(1).optional(),
  // set — виставити баланс рівним сумі; credit — додати; debit — списати.
  mode: z.enum(['set', 'credit', 'debit']),
  amount: targetAmount,
  // Обов’язкова: правка чужого рахунку без причини робить журнал марним.
  comment: z.string().trim().min(3, 'вкажіть причину').max(280, 'до 280 символів'),
})
