import * as domain from '../domain/businesses.ts'
import {
  cashCountSchema,
  createBusinessSchema,
  dashboardQuerySchema,
  monthlyQuerySchema,
  profitSeriesQuerySchema,
  registerPatchSchema,
  spendingSchema,
  registerSchema,
  internalTransferSchema,
  startingCapitalSchema,
} from '../validation/businesses.ts'
import { idempotencyKeyOf } from '../idempotency.ts'
import { iso, money } from '../serialize.ts'
import type { FastifyInstance } from 'fastify'

const serializeBusiness = (b: Record<string, any>) => ({
  id: b.id,
  name: b.name,
  description: b.description ?? null,
  baseCurrency: b.baseCurrency,
  isVerified: b.isVerified ?? false,
  createdAt: iso(b.createdAt),
})

const serializeRegister = (r: Record<string, any>) => ({
  id: r.id,
  name: r.name,
  currency: r.currency,
  isActive: r.isActive,
  balance: money(r.balance ?? 0n),
})

const serializeCount = (c: Record<string, any>) => ({
  id: c.id,
  countedAt: iso(c.countedAt),
  note: c.note ?? null,
  transactionId: c.transactionId ?? null,
  reversedAt: iso(c.reversedAt),
  lines: (c.lines ?? []).map((line: Record<string, any>) => ({
    kind: line.kind,
    registerId: line.registerId ?? null,
    currency: line.currency,
    counted: money(line.counted),
    previous: money(line.previous),
    delta: money(line.delta),
  })),
})

/** Routes that take an `:id` path parameter. */
type IdParams = { Params: { id: string } }

export default async function businessRoutes(fastify: FastifyInstance) {
  const borrower = fastify.guard(['borrow'])

  fastify.post('/businesses', { preHandler: borrower }, async (request, reply) => {
    const body = createBusinessSchema.parse(request.body)
    const business = await domain.createBusiness({ userId: request.user.id, ...body })
    return reply.code(201).send(serializeBusiness(business))
  })

  fastify.get('/businesses/me', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    const capital = await domain.currentStartingCapital(business.id)
    return {
      ...serializeBusiness(business),
      startingCapital: capital
        ? { amount: money(capital.amount), currency: capital.currency, effectiveFrom: iso(capital.effectiveFrom) }
        : null,
    }
  })

  fastify.put('/businesses/me/starting-capital', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    const body = startingCapitalSchema.parse(request.body)
    const row = await domain.setStartingCapital(business.id, body)
    return { amount: money(row.amount), currency: row.currency, effectiveFrom: iso(row.effectiveFrom) }
  })

  fastify.get('/businesses/me/dashboard', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    const query = dashboardQuerySchema.parse(request.query)
    const data = await domain.dashboard(business.id, { in: query.in })
    return {
      baseCurrency: data.baseCurrency,
      assets: money(data.assets),
      liabilities: money(data.liabilities),
      netWorth: money(data.netWorth),
      profit: money(data.profit),
      equity: money(data.equity),
      operatingProfit: money(data.operatingProfit),
      income: money(data.income),
      expense: money(data.expense),
      draw: money(data.draw),
      capital: money(data.capital),
      ownerEquity: money(data.ownerEquity),
      // У валютах внесення: курс не має рухати те, що вже вкладено.
      ownerCapital: data.ownerCapital.map((row) => ({
        currency: row.currency,
        capital: money(row.capital),
        draw: money(row.draw),
        equity: money(row.equity),
      })),
      startingCapital: data.startingCapital
        ? {
            amount: money(data.startingCapital.amount),
            currency: data.startingCapital.currency,
            base: money(data.startingCapital.base),
          }
        : null,
      byCurrency: data.byCurrency.map((row) => ({
        currency: row.currency,
        wallets: money(row.wallets),
        registers: money(row.registers),
        cash: money(row.cash),
        debt: money(row.debt),
        walletsBase: money(row.walletsBase),
        registersBase: money(row.registersBase),
        cashBase: money(row.cashBase),
        debtBase: money(row.debtBase),
      })),
      // Surfaced so the UI can say "valued at a stale rate" instead of
      // silently showing a number nobody can trust.
      staleCodes: data.staleCodes,
    }
  })

  fastify.get('/businesses/me/registers', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    const rows = await domain.listRegisters(business.id)
    return rows.map(serializeRegister)
  })

  fastify.post('/businesses/me/registers', { preHandler: borrower }, async (request, reply) => {
    const business = await domain.businessOf(request.user.id)
    const body = registerSchema.parse(request.body)
    const row = await domain.createRegister(business.id, body)
    return reply.code(201).send(serializeRegister({ ...row, balance: 0n }))
  })

  fastify.patch<IdParams>('/businesses/me/registers/:id', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    const body = registerPatchSchema.parse(request.body)
    const row = await domain.updateRegister(business.id, request.params.id, body)
    return serializeRegister(row)
  })

  fastify.delete<IdParams>('/businesses/me/registers/:id', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    return domain.deleteRegister(business.id, request.params.id)
  })

  // Одна стрічка на всі рухи грошей бізнесу — з журналу, а не з окремих
  // таблиць: повз журнал жодна операція не проходить.
  fastify.get('/businesses/me/history', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    const moves = await domain.businessHistory(business.id)
    return moves.map((move) => ({
      transactionId: move.transactionId,
      type: move.type,
      reversalOf: move.reversalOf ?? null,
      createdAt: iso(move.createdAt),
      comment: move.comment,
      lines: move.lines.map((line) => ({
        kind: line.kind,
        name: line.name,
        currency: line.currency,
        amount: money(line.amount),
      })),
    }))
  })

  // ─── Витрати й вилучення ──────────────────────────────────────────────────

  // Названий рух грошей із каси. Без нього все, що виходить, ловив би
  // перерахунок і списував у витрати — разом із тим, що власник забрав собі.
  fastify.post('/businesses/me/spending', { preHandler: borrower }, async (request, reply) => {
    const business = await domain.businessOf(request.user.id)
    const body = spendingSchema.parse(request.body)
    const result = await domain.recordSpending({
      businessId: business.id,
      userId: request.user.id,
      ...body,
      idempotencyKey: idempotencyKeyOf(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ transactionId: result.transactionId })
  })

  /**
   * Графік прибутку: точка на кожну подію, яка його змінила.
   *
   * Питання, на яке він відповідає: «чи росте те, що я заробляю, від
   * закриття до закриття». Тому вісь — не календар, а самі закриття й
   * витрати між ними.
   */
  fastify.get('/businesses/me/profit-series', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    const query = profitSeriesQuerySchema.parse(request.query)
    const data = await domain.profitSeries(business.id, { limit: query.limit, in: query.in })
    return {
      baseCurrency: data.baseCurrency,
      points: data.points.map((point) => ({
        transactionId: point.transactionId,
        type: point.type,
        at: iso(point.at),
        delta: money(point.delta),
        profit: money(point.profit),
      })),
    }
  })

  /**
   * Скасувати власний внесок або вилучення.
   *
   * Помилковий запис лишається в історії з позначкою «скасовано» — журнал не
   * переписується, а доповнюється зустрічною проводкою.
   */
  fastify.post<{ Params: { id: string } }>(
    '/businesses/me/owner-moves/:id/cancel',
    { preHandler: borrower },
    async (request, reply) => {
      const business = await domain.businessOf(request.user.id)
      const result = await domain.cancelOwnerMove(business.id, request.params.id, request.user.id)
      return reply.code(201).send({ transactionId: result.transactionId })
    },
  )

  // Помісячно: скільки заробив, витратив і забрав. Закривати місяць не треба —
  // журнал знає дату кожної проводки.
  fastify.get('/businesses/me/monthly', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    const query = monthlyQuerySchema.parse(request.query)
    const data = await domain.monthlyReport(business.id, { months: query.months, in: query.in })
    return {
      baseCurrency: data.baseCurrency,
      months: data.months.map((row) => ({
        month: row.month,
        income: money(row.income),
        expense: money(row.expense),
        draw: money(row.draw),
        capital: money(row.capital),
        profit: money(row.profit),
      })),
      total: {
        income: money(data.total.income),
        expense: money(data.total.expense),
        draw: money(data.total.draw),
        capital: money(data.total.capital),
        profit: money(data.total.profit),
      },
    }
  })

  // ─── Вечірній перерахунок ─────────────────────────────────────────────────

  // Що саме треба порахувати, з поточними залишками як підказкою.
  fastify.get('/businesses/me/count-sheet', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    const sheet = await domain.countSheet(business.id)
    return {
      registers: sheet.registers.map(serializeRegister),
      cash: sheet.cash.map((row) => ({ currency: row.currency, balance: money(row.balance) })),
    }
  })

  fastify.get('/businesses/me/cash-counts', { preHandler: borrower }, async (request) => {
    const business = await domain.businessOf(request.user.id)
    const counts = await domain.listCashCounts(business.id)
    return counts.map(serializeCount)
  })

  // Вводиться факт («у касі 42 300»), а не рух — різницю сервер проводить сам.
  fastify.post('/businesses/me/cash-counts', { preHandler: borrower }, async (request, reply) => {
    const business = await domain.businessOf(request.user.id)
    const body = cashCountSchema.parse(request.body)
    const result = await domain.countCash({
      userId: request.user.id,
      businessId: business.id,
      ...body,
      idempotencyKey: idempotencyKeyOf(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({
      ...serializeCount({ ...result.count, lines: result.lines }),
      // Порожній перелік означає, що перерахунок збігся з книгою до копійки.
      transactionId: result.count.transactionId,
    })
  })

  // Виправлення помилкової цифри: скасування, а не редагування. Проводки
  // незмінні, тож правка — це компенсуюча транзакція.
  fastify.post<IdParams>(
    '/businesses/me/cash-counts/:id/reverse',
    { preHandler: borrower },
    async (request) => {
      const business = await domain.businessOf(request.user.id)
      const count = await domain.reverseCashCount(business.id, request.params.id, request.user.id)
      return serializeCount(count)
    },
  )

  // Moving money between the owner's wallet, the business wallet and its
  // registers — including putting cash into a каса.
  fastify.post('/businesses/me/transfers', { preHandler: borrower }, async (request, reply) => {
    const business = await domain.businessOf(request.user.id)
    const body = internalTransferSchema.parse(request.body)
    const result = await domain.moveInternal({
      userId: request.user.id,
      businessId: business.id,
      ...body,
      idempotencyKey: idempotencyKeyOf(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ transactionId: result.transactionId })
  })

  fastify.get<IdParams>('/businesses/:id', { preHandler: fastify.authenticate }, async (request) => {
    const profile = await domain.publicProfile(request.params.id)
    return { ...serializeBusiness(profile), ownerName: profile.ownerName }
  })
}
