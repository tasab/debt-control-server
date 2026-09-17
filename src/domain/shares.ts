import { randomBytes } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { balanceShares, users } from '../../db/schema/index.ts'
import { newId } from '../money/amount.ts'
import { AppError, errors } from '../errors.ts'
import { walletsForUser } from '../money/balances.ts'
import { summary } from './stats.ts'

/**
 * Публічні посилання на власний баланс.
 *
 * Посилання — єдиний ключ до сторінки, і жодного іншого захисту в неї немає,
 * тож токен береться з crypto (128 біт), а не з лічильника й не з id
 * користувача: вгадати його має бути так само важко, як пароль.
 *
 * Назовні йде рівно те, що людина погодилася показати: імʼя, чиста вартість і
 * залишки по валютах. Ні пошти, ні історії, ні бізнесу, ні id — сторінка
 * призначена «показати, що гроші є», а не дати доступ до рахунку.
 */

const TOKEN_BYTES = 16

const newToken = () => randomBytes(TOKEN_BYTES).toString('base64url')

const invalidLink = () =>
  new AppError('NOT_FOUND', 'Посилання недійсне або відкликане', { status: 404 })

/** Усі посилання власника, свіжі згори. Відкликані лишаються у списку. */
export async function listShares(userId: string) {
  return db
    .select()
    .from(balanceShares)
    .where(eq(balanceShares.userId, userId))
    .orderBy(desc(balanceShares.createdAt))
}

export async function createShare(userId: string, { label }: { label?: string } = {}) {
  const [row] = await db
    .insert(balanceShares)
    .values({
      id: newId('shr'),
      userId,
      token: newToken(),
      label: label?.trim() || null,
    })
    .returning()
  return row
}

/**
 * Відкликання, а не видалення: рядок лишається, і посилання починає віддавати
 * 404 назавжди. Повторне відкликання нічого не змінює й не є помилкою.
 */
export async function revokeShare(userId: string, id: string) {
  const [row] = await db
    .update(balanceShares)
    .set({ revokedAt: sql`COALESCE(${balanceShares.revokedAt}, now())` })
    .where(and(eq(balanceShares.id, id), eq(balanceShares.userId, userId)))
    .returning()
  if (!row) throw errors.notFound('Посилання')
  return row
}

/**
 * Те, що бачить сторонній з посиланням.
 *
 * Лічильник переглядів пишеться тут же: власник має бачити, що посилання
 * розійшлося далі, ніж він розраховував, — це єдиний спосіб помітити, що його
 * час відкликати.
 */
export async function viewShare(token: string) {
  const [share] = await db
    .select({ id: balanceShares.id, userId: balanceShares.userId })
    .from(balanceShares)
    .where(and(eq(balanceShares.token, token), isNull(balanceShares.revokedAt)))
    .limit(1)

  // Відкликане й неіснуюче посилання відповідають однаково: інакше 404 проти
  // 410 сам по собі підказував би, що такий токен колись існував.
  if (!share) throw invalidLink()

  const [owner] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(and(eq(users.id, share.userId), isNull(users.deletedAt)))
    .limit(1)
  if (!owner) throw invalidLink()

  // Чиста вартість береться з того самого summary(), що й на гаманці власника.
  // Тут колись підсумовувалися лише гаманці — і в людини, яка віддала всі
  // кошти в бізнес, посилання показувало нуль: гроші нікуди не зникли, просто
  // лежали не там, де їх шукав цей підрахунок. Другого визначення «скільки в
  // мене всього» бути не повинно.
  const totals = await summary(share.userId)
  const wallets = await walletsForUser(share.userId)

  await db
    .update(balanceShares)
    .set({
      viewCount: sql`${balanceShares.viewCount} + 1`,
      lastViewedAt: new Date(),
    })
    .where(eq(balanceShares.id, share.id))

  return {
    displayName: owner.displayName,
    baseCurrency: totals.baseCurrency,
    netWorth: totals.netWorth,
    // Розклад: інакше велике число нічим не пояснене, а коли гаманці порожні,
    // бо все віддано в бізнес, сторінка виглядала б як помилка.
    onWallets: totals.wallets,
    invested: totals.invested,
    borrowed: totals.borrowed,
    // Порожні гаманці не показуються: перелік нулів нічого не додає, а сторінку
    // робить довшою за те єдине число, заради якого її відкрили.
    wallets: wallets.filter((wallet) => wallet.available > 0n),
    generatedAt: new Date(),
  }
}
