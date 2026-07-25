import { z } from 'zod'

// Shared building blocks. The client mirrors these shapes in
// client/src/lib/schema — same rules on both sides, server is authoritative.

/** A positive amount on the wire: a string of minor units. */
export const amountString = z
  .string()
  .regex(/^\d+$/, 'сума має бути рядком мінорних одиниць, напр. "100500"')
  .refine((v) => BigInt(v) > 0n, 'сума має бути більшою за нуль')

export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'код валюти з трьох літер')

export const comment = z.string().trim().max(280, 'до 280 символів').optional()

export const cursorQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
})

export const idempotencyKey = z.string().uuid().optional()

export const isoDate = z.string().datetime({ offset: true })

export const bps = z.coerce.number().int().min(0).max(1000000)
