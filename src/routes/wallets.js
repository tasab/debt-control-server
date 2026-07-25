import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { currencies } from '../../db/schema/index.js'
import { walletsForUser } from '../money/balances.js'
import { listTransactions, getTransaction } from '../domain/transactions.js'
import { serializeCurrency, serializeWallet } from '../serialize.js'
import { cursorQuery, currencyCode } from '../validation/common.js'

const historyQuery = cursorQuery.extend({
  currency: currencyCode.optional(),
  type: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().trim().min(1).optional(),
})

export default async function walletRoutes(fastify) {
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

  fastify.get('/transactions/:id', { preHandler: fastify.authenticate }, async (request) =>
    getTransaction(request.user.id, request.params.id),
  )
}
