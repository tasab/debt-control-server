import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/index.ts'
import {
  accounts,
  accountBalances,
  ledgerEntries,
  transactions,
  businesses,
  cashCountLines,
  cashCounts,
  registers,
  startingCapital,
  users,
} from '../../db/schema/index.ts'
import { errors } from '../errors.ts'
import { newId, parseAmount, toMajor } from '../money/amount.ts'
import { balanceOf, businessBalances } from '../money/balances.ts'
import { postTransaction, reverseTransaction } from '../money/ledger.ts'
import {
  businessCapital,
  businessCash,
  businessDraw,
  businessExpense,
  businessIncome,
  businessWallet,
  userWallet,
} from '../money/accounts.ts'
import { valuationTable } from '../money/valuation.ts'
import { liabilitiesOf } from './members.ts'
import type { CountLineKind, DbOrTx, LedgerEntryInput, Money, Tx } from '../types.ts'

export type Business = typeof businesses.$inferSelect
export type Register = typeof registers.$inferSelect
export type StartingCapital = typeof startingCapital.$inferSelect

export async function createBusiness({
  userId,
  name,
  description,
  baseCurrency,
  startingCapital: capital,
}: {
  userId: string
  name: string
  description?: string
  baseCurrency: string
  startingCapital?: { amount: string; currency: string }
}): Promise<Business> {
  const [existing] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.ownerUserId, userId))
    .limit(1)
  if (existing) throw errors.conflict('BUSINESS_EXISTS', 'Бізнес-профіль уже створено')

  return db.transaction(async (tx) => {
    const [business] = await tx
      .insert(businesses)
      .values({
        id: newId('biz'),
        ownerUserId: userId,
        name: name.trim(),
        description: description ?? null,
        baseCurrency,
      })
      .returning()

    // Starting capital is a dated setting, not a mutable field: the P&L
    // baseline must stay reproducible for any past date (PLATFORM_PLAN §5).
    if (capital) {
      await tx.insert(startingCapital).values({
        id: newId('cap'),
        businessId: business.id,
        amount: parseAmount(capital.amount, { field: 'startingCapital.amount' }),
        currency: capital.currency,
      })
    }
    return business
  })
}

export async function businessOf(userId: string): Promise<Business> {
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.ownerUserId, userId))
    .limit(1)
  if (!business) throw errors.notFound('Бізнес-профіль')
  return business
}

/** Публічний профіль — те, що видно учаснику поруч із назвою бізнесу. */
export async function publicProfile(businessId: string) {
  const [business] = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      description: businesses.description,
      baseCurrency: businesses.baseCurrency,
      isVerified: businesses.isVerified,
      createdAt: businesses.createdAt,
      ownerName: users.displayName,
    })
    .from(businesses)
    .innerJoin(users, eq(users.id, businesses.ownerUserId))
    .where(eq(businesses.id, businessId))
    .limit(1)
  if (!business) throw errors.notFound('Бізнес')
  return business
}

export async function setStartingCapital(
  businessId: string,
  { amount, currency }: { amount: string; currency: string },
): Promise<StartingCapital> {
  const [row] = await db
    .insert(startingCapital)
    .values({
      id: newId('cap'),
      businessId,
      amount: parseAmount(amount),
      currency,
    })
    .returning()
  return row
}

export async function currentStartingCapital(
  businessId: string,
  tx: DbOrTx = db,
): Promise<StartingCapital | null> {
  const [row] = await tx
    .select()
    .from(startingCapital)
    .where(
      and(
        eq(startingCapital.businessId, businessId),
        sql`${startingCapital.effectiveFrom} <= now()`,
      ),
    )
    .orderBy(sql`${startingCapital.effectiveFrom} DESC`)
    .limit(1)
  return row ?? null
}

// ─── Registers (каси) ───────────────────────────────────────────────────────

export async function listRegisters(businessId: string) {
  const rows = await db
    .select({
      id: registers.id,
      name: registers.name,
      currency: registers.currency,
      isActive: registers.isActive,
      accountId: registers.accountId,
      balance: sql`COALESCE(${accountBalances.balance}, 0)`,
    })
    .from(registers)
    .leftJoin(accountBalances, eq(accountBalances.accountId, registers.accountId))
    .where(and(eq(registers.businessId, businessId), isNull(registers.deletedAt)))
    .orderBy(registers.createdAt)
  return rows.map((r) => ({ ...r, balance: BigInt(r.balance as string) }))
}

export async function createRegister(
  businessId: string,
  { name, currency }: { name: string; currency: string },
): Promise<Register> {
  return db.transaction(async (tx) => {
    const accountId = newId('acc')
    await tx.insert(accounts).values({
      id: accountId,
      ownerType: 'business',
      ownerId: businessId,
      kind: 'business_register',
      currency,
      name,
    })
    await tx.insert(accountBalances).values({ accountId })
    const [register] = await tx
      .insert(registers)
      .values({ id: newId('reg'), businessId, accountId, name: name.trim(), currency })
      .returning()
    return register
  })
}

export async function updateRegister(
  businessId: string,
  registerId: string,
  patch: { name?: string; isActive?: boolean },
): Promise<Register> {
  const [row] = await db
    .update(registers)
    .set({ name: patch.name, isActive: patch.isActive })
    .where(and(eq(registers.id, registerId), eq(registers.businessId, businessId)))
    .returning()
  if (!row) throw errors.notFound('Касу')
  await db.update(accounts).set({ name: row.name }).where(eq(accounts.id, row.accountId))
  return row
}

/** Soft delete only — nothing financial is ever removed (PLATFORM_PLAN §8). */
export async function deleteRegister(businessId: string, registerId: string) {
  const [row] = await db
    .select()
    .from(registers)
    .where(and(eq(registers.id, registerId), eq(registers.businessId, businessId)))
    .limit(1)
  if (!row) throw errors.notFound('Касу')

  const [balance] = await db
    .select({ balance: accountBalances.balance })
    .from(accountBalances)
    .where(eq(accountBalances.accountId, row.accountId))
  if ((balance?.balance ?? 0n) !== 0n) {
    throw errors.conflict('REGISTER_NOT_EMPTY', 'Спершу перекажіть залишок каси', {
      register: 'каса не порожня',
    })
  }

  await db
    .update(registers)
    .set({ deletedAt: new Date(), isActive: false })
    .where(eq(registers.id, registerId))
  await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, row.accountId))
  return { ok: true }
}

// ─── Internal money movement ────────────────────────────────────────────────

/**
 * Move money between the owner's personal wallet, the business wallet and its
 * registers. Cash in a каса is an account like any other (§5), so "put 5000 UAH
 * into register 1" is an ordinary two-entry transaction, not a special case.
 *
 * Endpoints are `owner`, `business`, `cash` (готівка поза касами) or
 * `register:<id>`.
 */
export async function moveInternal({
  userId,
  businessId,
  from,
  to,
  currency,
  amount,
  comment,
  idempotencyKey,
}: {
  userId: string
  businessId: string
  from: string
  to: string
  currency: string
  amount: string
  comment?: string
  idempotencyKey?: string | null
}) {
  const value = parseAmount(amount)
  if (value <= 0n) throw errors.validation('Сума має бути більшою за нуль', { amount: 'мін. 0.01' })
  if (from === to) throw errors.validation('Оберіть різні рахунки', { to: 'той самий рахунок' })

  return db.transaction(async (tx) => {
    const resolve = async (endpoint: string): Promise<{ id: string }> => {
      if (endpoint === 'owner') return userWallet(userId, currency, tx)
      if (endpoint === 'business') return businessWallet(businessId, currency, tx)
      // Готівка поза касами — те саме, що перераховується ввечері, і те, куди
      // заходять кошти учасників. Без цього напрямку вона була б рахунком, з
      // якого нічого не можна ані взяти, ані покласти вручну.
      if (endpoint === 'cash') return businessCash(businessId, currency, tx)
      if (endpoint.startsWith('register:')) {
        const registerId = endpoint.slice('register:'.length)
        const [row] = await tx
          .select()
          .from(registers)
          .where(and(eq(registers.id, registerId), eq(registers.businessId, businessId)))
          .limit(1)
        if (!row) throw errors.notFound('Касу')
        if (row.currency !== currency) {
          throw errors.validation('Валюта каси не збігається', {
            currency: `каса в ${row.currency}`,
          })
        }
        return { id: row.accountId }
      }
      throw errors.validation('Невідомий рахунок', { from: endpoint })
    }

    const source = await resolve(from)
    const target = await resolve(to)

    return postTransaction(
      {
        type: 'internal_transfer',
        idempotencyKey,
        actorId: userId,
        meta: { businessId, from, to },
        entries: [
          { accountId: source.id, currency, amount: -value, entryType: 'internal_out', comment },
          { accountId: target.id, currency, amount: value, entryType: 'internal_in', comment },
        ],
      },
      tx,
    )
  })
}

// ─── Вечірній перерахунок ───────────────────────────────────────────────────

export type CashCount = typeof cashCounts.$inferSelect

interface CountTarget {
  accountId: string
  kind: CountLineKind
  registerId: string | null
  currency: string
  counted: Money
}

/**
 * Перерахунок: власник вводить **факт** — скільки насправді лежить у кожній
 * касі й скільки готівки поза ними по кожній валюті. Різницю з тим, що каже
 * книга, система проводить сама, і друга сторона кожної такої проводки — P&L:
 * надлишок стає виторгом дня, нестача — витратою.
 *
 * Саме тому денний виторг не треба вводити окремо. Ти не вносиш продажі — ти
 * вносиш підсумок, а різниця сама опиняється там, де їй місце.
 *
 * Увесь перерахунок — одна транзакція в журналі, тож або він застосувався
 * цілком, або не застосувався взагалі.
 */
export async function countCash({
  userId,
  businessId,
  registers: registerLines = [],
  cash: cashLines = [],
  note,
  countedAt,
  idempotencyKey,
}: {
  userId: string
  businessId: string
  registers?: Array<{ registerId: string; amount: string }>
  cash?: Array<{ currency: string; amount: string }>
  note?: string
  countedAt?: string
  idempotencyKey?: string | null
}) {
  if (registerLines.length === 0 && cashLines.length === 0) {
    throw errors.validation('Вкажіть хоча б один залишок', { registers: 'порожній перерахунок' })
  }
  assertUnique(registerLines.map((r) => r.registerId), 'Каса вказана двічі', 'registers')
  assertUnique(cashLines.map((c) => c.currency), 'Валюта вказана двічі', 'cash')

  return db.transaction(async (tx) => {
    const targets = await resolveTargets(tx, businessId, registerLines, cashLines)

    // Блокуємо залишки ДО того, як рахуємо дельти. Інакше паралельний рух
    // коштів між читанням і проводкою тихо зіпсував би різницю: ми списали б
    // те, чого вже немає, і перерахунок розійшовся б із фактом у касі.
    const previous = await lockBalances(tx, targets.map((t) => t.accountId))

    const lines = targets.map((target) => {
      const before = previous.get(target.accountId) ?? 0n
      return { ...target, previous: before, delta: target.counted - before }
    })

    // Σ по кожній валюті окремо — журнал балансується по валютах, не загалом.
    const netByCurrency = new Map<string, Money>()
    const entries: LedgerEntryInput[] = []
    for (const line of lines) {
      if (line.delta === 0n) continue
      netByCurrency.set(line.currency, (netByCurrency.get(line.currency) ?? 0n) + line.delta)
      entries.push({
        accountId: line.accountId,
        currency: line.currency,
        amount: line.delta,
        entryType: 'count_adjustment',
        comment: note ?? null,
      })
    }

    // Друга сторона: надлишок → виторг, нестача → витрата. Нуль означає, що
    // гроші лише перемістились між касами — це вже збалансована проводка.
    for (const [currency, net] of netByCurrency) {
      if (net === 0n) continue
      const account =
        net > 0n
          ? await businessIncome(businessId, currency, tx)
          : await businessExpense(businessId, currency, tx)
      entries.push({
        accountId: account.id,
        currency,
        amount: -net,
        entryType: net > 0n ? 'count_surplus' : 'count_shortfall',
        comment: note ?? null,
      })
    }

    // Перерахунок, що збігся з книгою до копійки, — теж факт: він зберігається,
    // просто проводити нема чого.
    const posted =
      entries.length > 0
        ? await postTransaction(
            {
              type: 'cash_count',
              idempotencyKey,
              actorId: userId,
              meta: { businessId },
              entries,
            },
            tx,
          )
        : null

    const countId = newId('cnt')
    const [count] = await tx
      .insert(cashCounts)
      .values({
        id: countId,
        businessId,
        transactionId: posted?.transactionId ?? null,
        countedBy: userId,
        note: note ?? null,
        ...(countedAt ? { countedAt: new Date(countedAt) } : {}),
      })
      .returning()

    await tx.insert(cashCountLines).values(
      lines.map((line) => ({
        id: newId('cnl'),
        countId,
        accountId: line.accountId,
        kind: line.kind,
        registerId: line.registerId,
        currency: line.currency,
        counted: line.counted,
        previous: line.previous,
        delta: line.delta,
      })),
    )

    return { count: count!, lines, replayed: posted?.replayed ?? false }
  })
}

const assertUnique = (values: string[], message: string, field: string) => {
  if (new Set(values).size !== values.length) throw errors.validation(message, { [field]: message })
}

/** Рядки перерахунку → рахунки журналу, з перевіркою належності бізнесу. */
async function resolveTargets(
  tx: Tx,
  businessId: string,
  registerLines: Array<{ registerId: string; amount: string }>,
  cashLines: Array<{ currency: string; amount: string }>,
): Promise<CountTarget[]> {
  const targets: CountTarget[] = []

  if (registerLines.length > 0) {
    const rows = await tx
      .select()
      .from(registers)
      .where(
        and(
          eq(registers.businessId, businessId),
          isNull(registers.deletedAt),
          inArray(registers.id, registerLines.map((r) => r.registerId)),
        ),
      )
    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const line of registerLines) {
      const row = byId.get(line.registerId)
      if (!row) throw errors.notFound('Касу')
      targets.push({
        accountId: row.accountId,
        kind: 'register',
        registerId: row.id,
        currency: row.currency,
        counted: countedAmount(line.amount, `каса «${row.name}»`),
      })
    }
  }

  for (const line of cashLines) {
    const account = await businessCash(businessId, line.currency, tx)
    targets.push({
      accountId: account.id,
      kind: 'cash',
      registerId: null,
      currency: line.currency,
      counted: countedAmount(line.amount, `готівка ${line.currency}`),
    })
  }

  return targets
}

/** Порахувати можна нуль, але не мінус — у касі не буває від'ємної готівки. */
function countedAmount(value: string, label: string): Money {
  const parsed = parseAmount(value, { field: 'amount' })
  if (parsed < 0n) {
    throw errors.validation(`Залишок не може бути від'ємним: ${label}`, { amount: 'мін. 0' })
  }
  return parsed
}

/**
 * SELECT … FOR UPDATE у порядку id — тому самому, в якому блокує журнал
 * (money/ledger.ts §2), тож два одночасні перерахунки стають у чергу замість
 * взаємного блокування.
 */
async function lockBalances(tx: Tx, accountIds: string[]): Promise<Map<string, Money>> {
  const ids = [...new Set(accountIds)].sort()
  if (ids.length === 0) return new Map()
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )
  const locked = await tx.execute(
    sql`SELECT account_id, balance FROM ${accountBalances}
        WHERE account_id IN (${list})
        ORDER BY account_id
        FOR UPDATE`,
  )
  const rows = (locked.rows ?? locked) as Array<{ account_id: string; balance: string }>
  return new Map(rows.map((r) => [r.account_id, BigInt(r.balance)]))
}

/**
 * Скасування перерахунку.
 *
 * Помилкова цифра не переписується — проводки незмінні (§2.3), тож
 * виправлення це компенсуюча транзакція. Історія лишається повною: видно і
 * помилку, і те, що її скасували.
 *
 * Просто перерахувати касу заново замало: перерахунок задає абсолютний
 * залишок, тож каса стала б правильною, але хибна різниця так і лишилася б
 * у виторзі, і «скільки заробив» показувало б гроші, яких не було.
 */
export async function reverseCashCount(businessId: string, countId: string, userId: string) {
  return db.transaction(async (tx) => {
    const [count] = await tx
      .select()
      .from(cashCounts)
      .where(and(eq(cashCounts.id, countId), eq(cashCounts.businessId, businessId)))
      .limit(1)
    if (!count) throw errors.notFound('Перерахунок')
    if (count.reversedAt) {
      throw errors.conflict('COUNT_REVERSED', 'Цей перерахунок уже скасовано')
    }

    // Перерахунок, що збігся з книгою, нічого не проводив — скасовувати нема
    // чого, лишається тільки позначити його.
    const reversal = count.transactionId
      ? await reverseTransaction(
          {
            transactionId: count.transactionId,
            actorId: userId,
            reason: 'Скасування перерахунку',
          },
          tx,
        )
      : null

    const [updated] = await tx
      .update(cashCounts)
      .set({
        reversedAt: new Date(),
        reversedBy: userId,
        reversalTxId: reversal?.transactionId ?? null,
      })
      .where(eq(cashCounts.id, countId))
      .returning()
    return updated!
  })
}

/** Історія перерахунків — те, що ти вводив, а не дельти в журналі. */
export async function listCashCounts(businessId: string, limit = 30) {
  const counts = await db
    .select()
    .from(cashCounts)
    .where(eq(cashCounts.businessId, businessId))
    .orderBy(sql`${cashCounts.countedAt} DESC`)
    .limit(limit)
  if (counts.length === 0) return []

  const lines = await db
    .select()
    .from(cashCountLines)
    .where(inArray(cashCountLines.countId, counts.map((c) => c.id)))

  const byCount = new Map<string, typeof lines>()
  for (const line of lines) {
    const bucket = byCount.get(line.countId) ?? []
    bucket.push(line)
    byCount.set(line.countId, bucket)
  }
  return counts.map((count) => ({ ...count, lines: byCount.get(count.id) ?? [] }))
}

/**
 * Форма перерахунку: усе, що треба порахувати ввечері, з поточними залишками
 * як підказкою. Валюти готівки — ті, в яких уже щось лежить, плюс валюти кас,
 * щоб нову валюту не довелося шукати в списку вручну.
 */
export async function countSheet(businessId: string) {
  const [registerRows, balances] = await Promise.all([
    listRegisters(businessId),
    businessBalances(businessId),
  ])
  const cash = balances
    .filter((account) => account.kind === 'business_cash')
    .map((account) => ({ currency: account.currency, balance: account.balance }))
    .sort((a, b) => a.currency.localeCompare(b.currency))

  return { registers: registerRows, cash }
}

// ─── Витрати й вилучення ────────────────────────────────────────────────────

/**
 * Названий рух грошей із каси.
 *
 * Без цієї операції будь-яке зменшення каси ловив би вечірній перерахунок і
 * списував у витрати анонімно. Для зарплати це майже правильно — сума та сама,
 * але «за що» втрачається. Для грошей, які власник забрав собі, це просто
 * хибно: вилучення прибутку не є витратою, і якщо його порахувати витратою,
 * прибуток за місяць завжди виходитиме нуль.
 *
 * `kind`:
 *   expense — витрата: зарплати, оренда, закупівля. Зменшує прибуток.
 *   draw    — вилучення власником. Зменшує активи, прибуток не чіпає.
 *   capital — власні гроші, внесені в бізнес. Теж не чіпає прибутку:
 *             принесені гроші не є заробленими.
 *
 * Для внеску `source` каже, звідки гроші взялися:
 *   register/cash — приніс зараз, каса зросте;
 *   income        — гроші вже в касі, але перерахунок записав їх виторгом.
 *                   Тоді каса не рухається взагалі, а сума просто переходить
 *                   із виторгу у власний капітал. Це виправлення класифікації,
 *                   а не рух грошей, і без нього перший же перерахунок
 *                   назавжди зараховував би власні кошти в прибуток.
 */
export async function recordSpending({
  businessId,
  userId,
  kind,
  source,
  currency,
  amount,
  comment,
  occurredAt,
  idempotencyKey,
}: {
  businessId: string
  userId: string
  kind: 'expense' | 'draw' | 'capital'
  source: string
  currency: string
  amount: string
  comment: string
  occurredAt?: string
  idempotencyKey?: string | null
}) {
  const value = parseAmount(amount)
  const at = occurredAt ? new Date(occurredAt) : undefined
  if (value <= 0n) throw errors.validation('Сума має бути більшою за нуль', { amount: 'мін. 0.01' })

  if (source === 'income' && kind !== 'capital') {
    throw errors.validation('З виторгу можна лише перекласифікувати власні кошти', {
      source: 'лише для внеску',
    })
  }

  return db.transaction(async (tx) => {
    // Каса чи готівка — той самий рахунок в усіх трьох випадках, різниця лише
    // в напрямку: внесок наповнює її, витрата й вилучення спустошують.
    // Виняток — перекласифікація: там другий бік це виторг, і каса не рухається.
    if (source === 'income')
      return reclassifyIncome(tx, businessId, userId, currency, value, comment, idempotencyKey, at)

    const cash = await resolveSource(tx, businessId, source, currency)
    const counterpart =
      kind === 'expense'
        ? await businessExpense(businessId, currency, tx)
        : kind === 'draw'
          ? await businessDraw(businessId, currency, tx)
          : await businessCapital(businessId, currency, tx)

    const sign = kind === 'capital' ? 1n : -1n

    return postTransaction(
      {
        type: `business_${kind}`,
        idempotencyKey,
        actorId: userId,
        occurredAt: at,
        meta: { businessId, kind, source },
        entries: [
          { accountId: cash.id, currency, amount: sign * value, entryType: kind, comment },
          { accountId: counterpart.id, currency, amount: -sign * value, entryType: kind, comment },
        ],
      },
      tx,
    )
  })
}

/**
 * «Це були мої гроші, а не виторг».
 *
 * Каса не рухається: гроші вже в ній. Рухається лише те, чим вони вважаються —
 * сума переходить із виторгу у власний капітал, і прибуток падає рівно на неї.
 */
async function reclassifyIncome(
  tx: Tx,
  businessId: string,
  userId: string,
  currency: string,
  value: Money,
  comment: string,
  idempotencyKey?: string | null,
  occurredAt?: Date,
) {
  const income = await businessIncome(businessId, currency, tx)
  const capital = await businessCapital(businessId, currency, tx)

  // Виторг живе від'ємним, тож доступне до перекласифікації — це його модуль.
  const available = -(await balanceOf(income.id, tx))
  if (value > available) {
    throw errors.conflict(
      'NOT_ENOUGH_INCOME',
      `Виторгу в ${currency} лише ${toMajor(available, 2)} — більше перекласифікувати нема з чого`,
      { amount: 'більше, ніж є' },
    )
  }

  return postTransaction(
    {
      type: 'business_capital',
      idempotencyKey,
      actorId: userId,
      occurredAt,
      meta: { businessId, kind: 'capital', source: 'income' },
      entries: [
        { accountId: income.id, currency, amount: value, entryType: 'capital', comment },
        { accountId: capital.id, currency, amount: -value, entryType: 'capital', comment },
      ],
    },
    tx,
  )
}

/** `cash` або `register:<id>` — звідки фізично пішли гроші. */
async function resolveSource(
  tx: Tx,
  businessId: string,
  source: string,
  currency: string,
): Promise<{ id: string }> {
  if (source === 'cash') return businessCash(businessId, currency, tx)
  if (source.startsWith('register:')) {
    const [row] = await tx
      .select()
      .from(registers)
      .where(
        and(
          eq(registers.id, source.slice('register:'.length)),
          eq(registers.businessId, businessId),
          isNull(registers.deletedAt),
        ),
      )
      .limit(1)
    if (!row) throw errors.notFound('Касу')
    if (row.currency !== currency) {
      throw errors.validation('Валюта каси не збігається', { source: `каса в ${row.currency}` })
    }
    return { id: row.accountId }
  }
  throw errors.validation('Невідоме джерело', { source })
}

/**
 * Помісячний підсумок.
 *
 * Закривати місяць не треба: журнал знає дату кожної проводки, тож «скільки
 * заробив у травні» — це питання до вже наявних даних, а не до окремої
 * процедури закриття. Обнулення каси наприкінці місяця на ці числа не
 * впливає — воно лише переносить гроші, а не стирає історію.
 */
export async function monthlyReport(
  businessId: string,
  { months = 12, in: target }: { months?: number; in?: string | null } = {},
) {
  const { toBase, base } = await valuationTable(target)

  const rows = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${ledgerEntries.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM')`,
      kind: accounts.kind,
      currency: ledgerEntries.currency,
      total: sql<string>`SUM(${ledgerEntries.amount})`,
    })
    .from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .where(
      and(
        eq(accounts.ownerType, 'business'),
        eq(accounts.ownerId, businessId),
        inArray(accounts.kind, [
          'business_income',
          'business_expense',
          'business_draw',
          'business_capital',
        ]),
      ),
    )
    .groupBy(sql`1`, accounts.kind, ledgerEntries.currency)
    .orderBy(sql`1`)

  interface MonthRow {
    month: string
    income: Money
    expense: Money
    draw: Money
    capital: Money
    profit: Money
  }
  const empty = (month: string): MonthRow => ({
    month,
    income: 0n,
    expense: 0n,
    draw: 0n,
    capital: 0n,
    profit: 0n,
  })
  const byMonth = new Map<string, MonthRow>()
  for (const row of rows) {
    const entry = byMonth.get(row.month) ?? empty(row.month)
    const amount = BigInt(row.total)
    // Виторг і капітал накопичуються від'ємними — перевертаємо у звичне
    // «скільки прийшло».
    if (row.kind === 'business_income') entry.income += toBase(-amount, row.currency)
    if (row.kind === 'business_expense') entry.expense += toBase(amount, row.currency)
    if (row.kind === 'business_draw') entry.draw += toBase(amount, row.currency)
    if (row.kind === 'business_capital') entry.capital += toBase(-amount, row.currency)
    byMonth.set(row.month, entry)
  }

  const list = [...byMonth.values()]
    .map((row) => ({ ...row, profit: row.income - row.expense }))
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, months)

  return {
    baseCurrency: base,
    months: list,
    total: list.reduce(
      (acc, row) => ({
        income: acc.income + row.income,
        expense: acc.expense + row.expense,
        draw: acc.draw + row.draw,
        capital: acc.capital + row.capital,
        profit: acc.profit + row.profit,
      }),
      { income: 0n, expense: 0n, draw: 0n, capital: 0n, profit: 0n },
    ),
  }
}

/**
 * Як прибуток змінювався від закриття до закриття.
 *
 * Прибуток не нараховується рівномірно в часі: він з'являється стрибком тоді,
 * коли ввечері перерахували каси, і просідає, коли записали витрату. Тому
 * точка графіка — не день, а подія: одна проводка, яка зачепила виторг або
 * витрати. Між ними нічого не відбувається, і лінія має йти рівно.
 *
 * Накопичення рахується від самого початку, а `limit` тільки обрізає хвіст
 * для показу: інакше перша точка на екрані починалася б з нуля й графік
 * брехав би про те, скільки вже зароблено.
 */
export async function profitSeries(
  businessId: string,
  { limit = 60, in: target }: { limit?: number; in?: string | null } = {},
) {
  const { toBase, base } = await valuationTable(target)

  // Дата точки — коли рахували касу, а не коли рядок ліг у базу. Перерахунок
  // за минулий вечір записують наступного ранку, і на графіку він має стояти
  // тим вечором, інакше «закрив 1-го і 7-го» перетворюється на дві точки
  // сьогоднішнім числом.
  const at = sql<Date>`COALESCE(${cashCounts.countedAt}, ${ledgerEntries.createdAt})`

  const rows = await db
    .select({
      transactionId: ledgerEntries.transactionId,
      type: transactions.type,
      kind: accounts.kind,
      currency: ledgerEntries.currency,
      amount: ledgerEntries.amount,
      createdAt: at,
    })
    .from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .innerJoin(transactions, eq(transactions.id, ledgerEntries.transactionId))
    .leftJoin(cashCounts, eq(cashCounts.transactionId, ledgerEntries.transactionId))
    .where(
      and(
        eq(accounts.ownerType, 'business'),
        eq(accounts.ownerId, businessId),
        inArray(accounts.kind, ['business_income', 'business_expense']),
      ),
    )
    .orderBy(sql`${at} ASC`, ledgerEntries.id)

  // Одна дія людини — одна точка, навіть якщо вона зачепила виторг і витрати
  // однією проводкою.
  const byTransaction = new Map<
    string,
    { transactionId: string; type: string; at: Date; delta: Money }
  >()
  for (const row of rows) {
    const point = byTransaction.get(row.transactionId) ?? {
      transactionId: row.transactionId,
      type: row.type,
      at: row.createdAt,
      delta: 0n,
    }
    const amount = BigInt(row.amount)
    // Виторг накопичується від'ємним, витрати — додатним; прибуток росте на
    // перший і падає на другий.
    point.delta +=
      row.kind === 'business_income' ? toBase(-amount, row.currency) : -toBase(amount, row.currency)
    byTransaction.set(row.transactionId, point)
  }

  let running = 0n
  const points = [...byTransaction.values()].map((point) => {
    running += point.delta
    return { ...point, profit: running }
  })

  return { baseCurrency: base, points: points.slice(-limit) }
}

/**
 * Історія рухів по бізнесу.
 *
 * Одна стрічка на всі гроші: перерахунки, витрати, вилучення, внески, вклади
 * учасників, переміщення між касами. Береться з журналу, а не з окремих
 * таблиць, бо журнал і є повним списком того, що сталося, — жодна операція
 * повз нього не проходить.
 *
 * Рядки згруповані транзакціями: одна дія людини — один запис у стрічці,
 * навіть якщо вона зачепила п'ять рахунків.
 */
export async function businessHistory(businessId: string, limit = 100) {
  const rows = await db
    .select({
      transactionId: ledgerEntries.transactionId,
      type: transactions.type,
      // Яку операцію ця проводка скасовує — щоб у стрічці було видно, що
      // запис уже виправлений, а не лишився чинним.
      reversalOf: transactions.reversalOf,
      createdAt: ledgerEntries.createdAt,
      comment: ledgerEntries.comment,
      currency: ledgerEntries.currency,
      amount: ledgerEntries.amount,
      kind: accounts.kind,
      name: accounts.name,
    })
    .from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .innerJoin(transactions, eq(transactions.id, ledgerEntries.transactionId))
    .where(and(eq(accounts.ownerType, 'business'), eq(accounts.ownerId, businessId)))
    .orderBy(sql`${ledgerEntries.createdAt} DESC`)
    .limit(limit * 6)

  interface Entry {
    kind: string
    name: string | null
    currency: string
    amount: Money
  }
  interface Move {
    transactionId: string
    type: string
    reversalOf: string | null
    createdAt: Date
    comment: string | null
    lines: Entry[]
  }

  const byTransaction = new Map<string, Move>()
  for (const row of rows) {
    const move =
      byTransaction.get(row.transactionId) ?? {
        transactionId: row.transactionId,
        type: row.type,
        reversalOf: row.reversalOf,
        createdAt: row.createdAt,
        comment: row.comment,
        lines: [],
      }
    if (!move.comment && row.comment) move.comment = row.comment
    move.lines.push({
      kind: row.kind,
      name: row.name,
      currency: row.currency,
      amount: row.amount,
    })
    byTransaction.set(row.transactionId, move)
  }

  return [...byTransaction.values()]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit)
}

// ─── Dashboard (PLATFORM_PLAN §5 + Appendix A) ──────────────────────────────

/**
 * The old client-side engine.js, moved server-side and fed from the ledger
 * instead of hand-typed snapshots. Everything is valued in one currency at the
 * mid rate, and — unlike the spreadsheet this inherits from — conversion is
 * always applied to the *total* per currency, from one function.
 *
 * `in` міняє лише валюту показу. Гроші як лежали в своїх валютах, так і
 * лежать: перерахунок робиться на льоту при читанні й нічого не зберігає.
 */
export async function dashboard(businessId: string, { in: target }: { in?: string | null } = {}) {
  const [business] = await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1)
  if (!business) throw errors.notFound('Бізнес')

  const { toBase, base, staleCodes } = await valuationTable(target)
  const balances = await businessBalances(businessId)

  interface CurrencyRow {
    currency: string
    wallets: Money
    registers: Money
    cash: Money
    debt: Money
  }
  type CurrencyKey = 'wallets' | 'registers' | 'cash' | 'debt'
  const byCurrency = new Map<string, CurrencyRow>()
  const bump = (currency: string, key: CurrencyKey, value: Money) => {
    const row =
      byCurrency.get(currency) ?? { currency, wallets: 0n, registers: 0n, cash: 0n, debt: 0n }
    row[key] += value
    byCurrency.set(currency, row)
  }

  // P&L накопичується в журналі по валютах: виторг від'ємним, витрати
  // додатним. Обидва тут перевертаються в звичні «скільки заробив / витратив».
  let incomeBase = 0n
  let expenseBase = 0n
  let drawBase = 0n
  let capitalBase = 0n
  // Капітал у тих валютах, у яких його вносили. Гривневий еквівалент потрібен
  // лише для зведення з чистою вартістю; сам капітал у гривні не вимірюється —
  // якщо власник вніс $38 800, це $38 800, і курс тут ні до чого.
  const ownerByCurrency = new Map<string, { capital: Money; draw: Money }>()
  const bumpOwner = (currency: string, key: 'capital' | 'draw', value: Money) => {
    const row = ownerByCurrency.get(currency) ?? { capital: 0n, draw: 0n }
    row[key] += value
    ownerByCurrency.set(currency, row)
  }

  for (const account of balances) {
    if (account.kind === 'user_wallet') bump(account.currency, 'wallets', account.balance)
    if (account.kind === 'business_register') bump(account.currency, 'registers', account.balance)
    if (account.kind === 'business_cash') bump(account.currency, 'cash', account.balance)
    if (account.kind === 'business_income') incomeBase += toBase(-account.balance, account.currency)
    if (account.kind === 'business_expense') expenseBase += toBase(account.balance, account.currency)
    if (account.kind === 'business_draw') {
      drawBase += toBase(account.balance, account.currency)
      bumpOwner(account.currency, 'draw', account.balance)
    }
    if (account.kind === 'business_capital') {
      capitalBase += toBase(-account.balance, account.currency)
      bumpOwner(account.currency, 'capital', -account.balance)
    }
  }

  // Зобов'язання бізнесу — це борг перед учасниками, і він виводиться з
  // журналу, а не з окремої таблиці: рахунок учасника і є боргом.
  const memberDebt = await liabilitiesOf(businessId, target)
  for (const [currency, owed] of memberDebt.byCurrency) bump(currency, 'debt', owed)

  const currencyRows = [...byCurrency.values()].map((row) => ({
    ...row,
    walletsBase: toBase(row.wallets, row.currency),
    registersBase: toBase(row.registers, row.currency),
    cashBase: toBase(row.cash, row.currency),
    debtBase: toBase(row.debt, row.currency),
  }))

  const assets = currencyRows.reduce(
    (acc, r) => acc + r.walletsBase + r.registersBase + r.cashBase,
    0n,
  )
  const liabilities = currencyRows.reduce((acc, r) => acc + r.debtBase, 0n)
  const netWorth = assets - liabilities

  /**
   * Власний капітал — стартове число плюс те, що власник вніс і забрав потім.
   *
   * Стартове виставляє людина: на момент, коли бізнес заводять у систему,
   * гроші в ньому вже є, і зводити їх з порожнього журналу нема з чого. Але
   * далі кожен внесок і кожне вилучення проходять кнопкою й лягають у журнал
   * (`business_capital`, `business_draw`), тож їх не треба виставляти вручну —
   * вони вже пораховані.
   *
   * Раніше капітал дорівнював самому лише стартовому числу, і власний внесок
   * ішов просто в прибуток: каса росла, капітал стояв, різниця між ними
   * читалася як заробіток. Гроші, які принесли з дому, заробітком не є.
   *
   * Прибуток тоді очевидний: усе, що є, мінус чуже й мінус своє.
   */
  const capital = await currentStartingCapital(businessId)
  const startingBase = capital ? toBase(capital.amount, capital.currency) : 0n
  const equity = startingBase + capitalBase - drawBase
  const profit = netWorth - equity

  return {
    business,
    baseCurrency: base,
    assets,
    liabilities,
    netWorth,
    startingCapital: capital
      ? { amount: capital.amount, currency: capital.currency, base: startingBase }
      : null,
    // Скільки грошей власника зараз у справі: стартове число, внески й
    // вилучення разом. Саме проти нього рахується прибуток.
    equity,
    profit,
    /**
     * Прибуток від операцій — виторг мінус витрати, як їх показали
     * перерахунки.
     *
     * `profit` рахується від капіталу й тому не росте від внеску власника,
     * але він усе одно вбирає все, чого облік не бачив: знайдену готівку,
     * недостачу, курсову різницю. Сюди ж потрапляє лише те, що показали
     * перерахунки, — тобто власне торгівля. Переказ і виведення проходять
     * журналом, перерахунок їх не бачить, і на цю цифру вони не впливають.
     */
    operatingProfit: incomeBase - expenseBase,
    income: incomeBase,
    expense: expenseBase,
    // Вилучене власником: зменшує активи, але не прибуток. Показується
    // окремо, бо «заробив» і «забрав» — різні питання.
    draw: drawBase,
    // Внесено власником зі своєї кишені. Разом із вилученим дає «скільки моїх
    // грошей зараз у справі».
    capital: capitalBase,
    ownerEquity: capitalBase - drawBase,
    ownerCapital: [...ownerByCurrency.entries()]
      .map(([currency, row]) => ({ ...row, currency, equity: row.capital - row.draw }))
      .filter((row) => row.equity !== 0n)
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    byCurrency: currencyRows,
    staleCodes,
  }
}

/**
 * Скасувати власний внесок або вилучення.
 *
 * Дві різні операції під однією кнопкою, бо для людини це одне: «цього запису
 * не мало бути».
 *
 * Вилучення скасовується звичайним сторно — гроші, які ви забрали, ви
 * повертаєте, і каса росте назад.
 *
 * Внесок готівкою — ні. Його сторно забрало б із каси ті самі гроші, а вони
 * там уже давно не ті: їх витратили, перерахували, частину списали як
 * нестачу. Тому каса не рухається взагалі — рухається тільки те, чим ці
 * гроші вважаються: сума йде з вашого капіталу у виторг. Саме так помилка й
 * виглядає насправді: гроші в бізнесі були, але вашими вони не були.
 *
 * Внесок, зроблений з виторгу («вже в касі»), каси не торкався й тоді, тож
 * його достатньо просто сторнувати.
 */
export async function cancelOwnerMove(businessId: string, transactionId: string, userId: string) {
  const [original] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, transactionId))
    .limit(1)
  if (!original) throw errors.notFound('Операцію')

  const meta = (original.meta ?? {}) as { businessId?: string }
  const isOwnerMove = original.type === 'business_capital' || original.type === 'business_draw'
  if (!isOwnerMove || meta.businessId !== businessId) throw errors.notFound('Операцію')

  const [already] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.reversalOf, transactionId))
    .limit(1)
  if (already) throw errors.conflict('ALREADY_REVERSED', 'Цю операцію вже скасовано')

  const rows = await db
    .select({
      accountId: ledgerEntries.accountId,
      kind: accounts.kind,
      currency: ledgerEntries.currency,
      amount: ledgerEntries.amount,
    })
    .from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .where(eq(ledgerEntries.transactionId, transactionId))

  const touchedCash = rows.some(
    (row) => row.kind === 'business_cash' || row.kind === 'business_register',
  )

  if (original.type === 'business_draw' || !touchedCash) {
    return reverseTransaction(
      { transactionId, actorId: userId, reason: 'Скасування запису' },
      null,
    )
  }

  return db.transaction(async (tx) => {
    const entries: LedgerEntryInput[] = []
    for (const row of rows.filter((r) => r.kind === 'business_capital')) {
      // Внесок лежить на рахунку капіталу від'ємним — скасування повертає
      // його до нуля, а зустрічний бік іде у виторг.
      const value = -BigInt(row.amount)
      const income = await businessIncome(businessId, row.currency, tx)
      entries.push({
        accountId: row.accountId,
        currency: row.currency,
        amount: value,
        entryType: 'capital',
        comment: 'Скасування внеску',
      })
      entries.push({
        accountId: income.id,
        currency: row.currency,
        amount: -value,
        entryType: 'capital',
        comment: 'Скасування внеску',
      })
    }
    if (entries.length === 0) throw errors.conflict('NOTHING_TO_CANCEL', 'Нічого скасовувати')

    const posted = await postTransaction(
      {
        type: 'business_capital_cancel',
        actorId: userId,
        meta: { businessId, reversalOf: transactionId },
        entries,
      },
      tx,
    )
    await tx
      .update(transactions)
      .set({ reversalOf: transactionId })
      .where(eq(transactions.id, posted.transactionId))
    return posted
  })
}
