import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.ts'
import { currencies } from '../../db/schema/index.ts'
import { walletsForUser } from '../money/balances.ts'
import { listTransactions, getTransaction } from '../domain/transactions.ts'
import { serializeCurrency, serializeWallet } from '../serialize.ts'
import { cursorQuery, currencyCode } from '../validation/common.ts'
import type { FastifyInstance } from 'fastify'

const historyQuery = cursorQuery.extend({
  currency: currencyCode.optional(),
  type: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().trim().min(1).optional(),
})


/** Routes that take an `:id` path parameter. */
type IdParams = { Params: { id: string } }

export default async function walletRoutes(fastify: FastifyInstance) {
  fastify.get('/currencies', async () => {
    const rows = await db
      .select()
      .from(currencies)
      .where(eq(currencies.isActive, true))
      .orderBy(currencies.sortOrder)
    return rows.map(serializeCurrency)
  })

  fastify.get('/wallets', { preHandler: fastify.authenticate }, async (request) => {
    const wallets = await walletsForUser(request.user.id)
    return wallets.map(serializeWallet)
  })

  fastify.get('/transactions', { preHandler: fastify.authenticate }, async (request) => {
    const query = historyQuery.parse(request.query)
    return listTransactions(request.user.id, query)
  })

  fastify.get<IdParams>('/transactions/:id', { preHandler: fastify.authenticate }, async (request) =>
    getTransaction(request.user.id, request.params.id),
  )
}
