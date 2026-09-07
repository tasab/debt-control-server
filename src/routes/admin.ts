import {
  adjustBalance,
  deleteParticipant,
  listParticipants,
  participantAdjustments,
} from '../domain/admin.ts'
import { adjustBalanceSchema, listParticipantsSchema } from '../validation/admin.ts'
import { idempotencyKeyOf } from '../idempotency.ts'
import { iso, money, serializeWallet } from '../serialize.ts'
import { contextOf } from '../types.ts'
import type { FastifyInstance } from 'fastify'

/** Routes that take an `:id` path parameter. */
type IdParams = { Params: { id: string } }

export default async function adminRoutes(fastify: FastifyInstance) {
  // Every route here is behind `guard(['admin'])` — capability checks live on
  // the server, never in the client's navigation (PLATFORM_PLAN §8).
  // М'яке видалення: рядок лишається заради проводок, але людина зникає зі
  // списків і втрачає активні сесії.
  // `force=true` дописує залишки й видаляє попри них. Прапорець явний, щоб
  // випадковий виклик не зміг стерти чужі гроші мовчки.
  fastify.delete<IdParams>('/admin/users/:id', { preHandler: fastify.guard(['admin']) }, async (request) => {
    const { force } = request.query as { force?: string }
    const result = await deleteParticipant(
      { adminId: request.user.id, userId: request.params.id, force: force === 'true' },
      contextOf(request),
    )
    return {
      ok: result.ok,
      writtenOff: result.writtenOff.map((row) => ({
        currency: row.currency,
        amount: money(row.amount),
        source: row.source,
      })),
    }
  })

  fastify.get('/admin/users', { preHandler: fastify.guard(['admin']) }, async (request) => {
    const query = listParticipantsSchema.parse(request.query)
    const items = await listParticipants({ query: query.q, limit: query.limit })
    return {
      items: items.map((user) => ({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        capabilities: user.capabilities,
        isAdmin: user.isAdmin,
        businessName: user.businessName,
        wallets: user.wallets.map(serializeWallet),
        invested: user.invested.map((row) => ({
          memberId: row.memberId,
          currency: row.currency,
          amount: money(row.amount),
          businessName: row.businessName,
        })),
      })),
    }
  })

  fastify.get<IdParams>(
    '/admin/users/:id/adjustments',
    { preHandler: fastify.guard(['admin']) },
    async (request) => {
      const rows = await participantAdjustments(request.params.id)
      return {
        items: rows.map((row) => {
          const meta = (row.meta ?? {}) as Record<string, string>
          return {
            id: row.id,
            type: row.type,
            currency: meta.currency ?? null,
            before: meta.before ? money(BigInt(meta.before)) : null,
            after: meta.after ? money(BigInt(meta.after)) : null,
            comment: meta.comment ?? null,
            actor: row.actorName ?? null,
            createdAt: iso(row.createdAt),
          }
        }),
      }
    },
  )

  fastify.post<IdParams>(
    '/admin/users/:id/adjustments',
    { preHandler: fastify.guard(['admin']) },
    async (request, reply) => {
      const body = adjustBalanceSchema.parse(request.body)
      const result = await adjustBalance(
        {
          adminId: request.user.id,
          userId: request.params.id,
          ...body,
          idempotencyKey: idempotencyKeyOf(request),
        },
        contextOf(request),
      )
      return reply.code(result.replayed ? 200 : 201).send({
        transactionId: result.transactionId,
        before: money(result.before),
        after: money(result.after),
        delta: money(result.delta),
        // Непорожній — кошти пішли в бізнес, і `after` це вже враховує.
        swept: result.swept.map((row) => ({
          currency: row.currency,
          amount: money(row.amount),
        })),
      })
    },
  )
}
