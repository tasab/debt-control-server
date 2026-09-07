import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from '../db/index.ts'
import {
  accounts,
  businessMembers,
  businesses,
  ledgerEntries,
} from '../../db/schema/index.ts'
import { walletsForUser } from '../money/balances.ts'
import { valuationTable } from '../money/valuation.ts'
import { claimBalances, liabilitiesOf } from './members.ts'
import type { Money } from '../types.ts'

interface HistoryPoint {
  date: string
  totalBase: Money
  kinds: Record<string, Money>
  currencies: Record<string, Money>
}

/** YYYY-MM-DD в UTC — ключ, за яким групується день. */
export const dayKey = (date: Date | string = new Date()): string =>
  new Date(date).toISOString().slice(0, 10)

const addDays = (key: string, days: number): string => {
  const d = new Date(`${key}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return dayKey(d)
}

/**
 * Графік портфеля, виведений із журналу проводок.
 *
 * Не зі знімків: знімок з'являється лише в той день, коли працював джоб, тож
 * вимкнений на ніч сервер лишав би в історії дірку, а рік тому знімків немає
 * взагалі. Журнал натомість пам'ятає кожен рух від першого дня, тому графік
 * будується заднім числом і точно — це та сама сума проводок, що й будь-який
 * баланс у цьому додатку.
 *
 * Оцінка в базовій валюті робиться за поточним курсом на всю історію: так
 * крива показує рух власне грошей, а не коливання курсу під ними.
 */
export async function balanceHistory({
  userId,
  from,
  to,
  currency,
}: {
  userId: string
  from?: string
  to?: string
  currency?: string
}): Promise<HistoryPoint[]> {
  const { toBase } = await valuationTable()

  // Гаманець — рахунки людини; вкладене — рахунки її участей, з протилежним
  // знаком, бо в журналі вимога живе від'ємною.
  const memberships = await db
    .select({ id: businessMembers.id })
    .from(businessMembers)
    .where(eq(businessMembers.userId, userId))
  const membershipIds = memberships.map((m) => m.id)

  const conditions = [
    and(
      eq(accounts.ownerType, 'user'),
      eq(accounts.ownerId, userId),
      eq(accounts.kind, 'user_wallet'),
    ),
  ]
  if (membershipIds.length > 0) {
    conditions.push(
      and(eq(accounts.ownerType, 'membership'), inArray(accounts.ownerId, membershipIds))!,
    )
  }

  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${ledgerEntries.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
      currency: ledgerEntries.currency,
      kind: accounts.kind,
      delta: sql<string>`SUM(${ledgerEntries.amount})`,
    })
    .from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .where(or(...conditions))
    .groupBy(sql`1`, ledgerEntries.currency, accounts.kind)
    .orderBy(sql`1`)

  if (rows.length === 0) return []

  const series = rows
    .filter((row) => !currency || row.currency === currency)
    .map((row) => ({
      day: row.day,
      currency: row.currency,
      // member_claim від'ємний у журналі; назовні «вкладено» — додатне.
      kind: row.kind === 'user_wallet' ? 'wallet' : 'invested',
      delta: row.kind === 'user_wallet' ? BigInt(row.delta) : -BigInt(row.delta),
    }))
  if (series.length === 0) return []

  const byDay = new Map<string, typeof series>()
  for (const row of series) {
    const bucket = byDay.get(row.day) ?? []
    bucket.push(row)
    byDay.set(row.day, bucket)
  }

  const first = series[0]!.day
  const last = dayKey(to ?? new Date())
  const start = from ? dayKey(from) : first
  const points: HistoryPoint[] = []

  // Наростаючий підсумок від першого руху: залишок дня — це сума всього, що
  // сталося включно з ним, тож дні без проводок просто повторюють попередній.
  const running = new Map<string, Money>() // "kind|currency" → залишок
  for (let day = first < start ? first : start; day <= last; day = addDays(day, 1)) {
    for (const row of byDay.get(day) ?? []) {
      const key = `${row.kind}|${row.currency}`
      running.set(key, (running.get(key) ?? 0n) + row.delta)
    }
    if (day < start) continue

    const point: HistoryPoint = { date: day, totalBase: 0n, kinds: {}, currencies: {} }
    for (const [key, amount] of running) {
      const [kind, code] = key.split('|') as [string, string]
      const base = toBase(amount, code)
      point.totalBase += base
      point.kinds[kind] = (point.kinds[kind] ?? 0n) + base
      point.currencies[code] = (point.currencies[code] ?? 0n) + amount
    }
    points.push(point)
  }

  return points
}

/**
 * Головні цифри: скільки в людини вільних коштів, скільки вкладено в бізнеси
 * і скільки винен її власний бізнес.
 *
 * Позик тут більше немає — вклад це не позика з графіком, а залишок рахунку
 * учасника, тож «скільки я вклав» — той самий запит по журналу, що й баланс.
 */
export async function summary(userId: string) {
  const { toBase, base } = await valuationTable()
  const wallets = await walletsForUser(userId)

  let walletBase = 0n
  for (const wallet of wallets) walletBase += toBase(wallet.available, wallet.currency)

  // Вкладено: борг усіх бізнесів, у яких людина є активним учасником.
  const memberships = await db
    .select()
    .from(businessMembers)
    .where(and(eq(businessMembers.userId, userId), eq(businessMembers.status, 'active')))

  let investedBase = 0n
  for (const membership of memberships) {
    for (const row of await claimBalances(membership.id)) {
      investedBase += toBase(row.balance, row.currency)
    }
  }

  // Заборгованість: скільки винен власний бізнес, якщо він є.
  let borrowedBase = 0n
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.ownerUserId, userId))
    .limit(1)
  if (business) borrowedBase = (await liabilitiesOf(business.id)).total

  return {
    baseCurrency: base,
    wallets: walletBase,
    invested: investedBase,
    borrowed: borrowedBase,
    netWorth: walletBase + investedBase - borrowedBase,
  }
}

/** CSV export of the transaction history (§7). */
export async function exportCsv(userId: string): Promise<string> {
  const rows = await db
    .select({
      createdAt: ledgerEntries.createdAt,
      type: ledgerEntries.entryType,
      currency: ledgerEntries.currency,
      amount: ledgerEntries.amount,
      comment: ledgerEntries.comment,
    })
    .from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .where(and(eq(accounts.ownerType, 'user'), eq(accounts.ownerId, userId)))
    .orderBy(ledgerEntries.createdAt)

  const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
  const lines = ['date,type,currency,amount,comment']
  for (const row of rows) {
    lines.push(
      [
        row.createdAt.toISOString(),
        row.type,
        row.currency,
        row.amount.toString(),
        escape(row.comment),
      ].join(','),
    )
  }
  return lines.join('\n')
}
