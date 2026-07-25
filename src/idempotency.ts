import { and, eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { idempotencyRecords } from '../db/schema/index.ts'
import type { FastifyRequest } from 'fastify'

/**
 * Every write accepts `Idempotency-Key` (SERVER_PLAN §2.1). Ledger writes get
 * their guarantee from transactions.idempotency_key; this module covers the
 * writes that do not post to the ledger.
 */
export function idempotencyKeyOf(request: FastifyRequest): string | null {
  const key = request.headers['idempotency-key']
  return typeof key === 'string' && key.length ? key : null
}

/**
 * Run `fn` once per (key, scope). A replay returns the stored response, so the
 * client sees the same body it would have got the first time.
 */
export async function withIdempotency<T>(
  { key, scope, userId }: { key: string | null; scope: string; userId: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (!key) return fn()

  const [existing] = await db
    .select()
    .from(idempotencyRecords)
    .where(and(eq(idempotencyRecords.key, key), eq(idempotencyRecords.scope, scope)))
    .limit(1)
  if (existing) return existing.response as T

  const response = await fn()
  await db
    .insert(idempotencyRecords)
    .values({ key, scope, userId, response: response as Record<string, unknown> })
    .onConflictDoNothing()
  return response
}
