import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/index.ts'
import {
  accountBalances,
  accounts,
  businessMembers,
  businesses,
  contributions,
  memberRates,
  registers,
  users,
} from '../../db/schema/index.ts'
import { errors } from '../errors.ts'
import { newId, parseAmount, toMajor } from '../money/amount.ts'
import { businessCash, externalAccount, memberClaim, userWallet } from '../money/accounts.ts'
import { balanceOf } from '../money/balances.ts'
import { postTransaction } from '../money/ledger.ts'
import { valuationTable } from '../money/valuation.ts'
import type { ContributionDirection, DbOrTx, LedgerEntryInput, Money, Tx } from '../types.ts'

export type Member = typeof businessMembers.$inferSelect
export type Contribution = typeof contributions.$inferSelect

/**
 * Учасники бізнесу (модель вкладів).
 *
 * Прив'язка — людина до бізнесу, а не окрема позика. Щойно участь активна,
 * борг бізнесу перед учасником — це просто залишок його рахунку `member_claim`,
 * від'ємного за знаком. Тому «скільки я винен Петрові» і «скільки всього я
 * винен» — це той самий запит по журналу, що й будь-який інший баланс.
 */

// ─── Участь ─────────────────────────────────────────────────────────────────

/** Власник додає інвестора зі списку користувачів. */
export async function invite(businessId: string, userId: string): Promise<Member> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1)
  if (!user) throw errors.notFound('Користувача')

  const [business] = await db
    .select({ ownerUserId: businesses.ownerUserId })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)
  if (business?.ownerUserId === userId) {
    throw errors.validation('Власник не може бути учасником власного бізнесу', {
      userId: 'це ви',
    })
  }

  const [existing] = await db
    .select()
    .from(businessMembers)
    .where(and(eq(businessMembers.businessId, businessId), eq(businessMembers.userId, userId)))
    .limit(1)

  // Повторне запрошення після виходу чи відмови оживляє той самий рядок:
  // історія вкладів і залишок рахунку прив'язані до нього, і другий рядок
  // розділив би борг перед однією людиною надвоє.
  if (existing) {
    if (existing.status !== 'ended' && existing.status !== 'declined') {
      throw errors.conflict('MEMBER_EXISTS', 'Цей користувач уже запрошений')
    }
    const [revived] = await db
      .update(businessMembers)
      .set({ status: 'pending', invitedAt: new Date(), endedAt: null, hiddenAt: null })
      .where(eq(businessMembers.id, existing.id))
      .returning()
    return revived!
  }

  const [member] = await db
    .insert(businessMembers)
    .values({ id: newId('mbr'), businessId, userId })
    .returning()
  return member!
}

/** Учасник приймає запрошення й називає свою ставку (0 — безвідсотково). */
export async function acceptInvite(
  memberId: string,
  userId: string,
  rateAnnualBps: number,
) {
  return db.transaction(async (tx) => {
    const member = await memberFor(tx, memberId)
    if (member.userId !== userId) throw errors.forbidden()
    if (member.status === 'active') throw errors.conflict('MEMBER_ACTIVE', 'Участь уже активна')
    if (member.status !== 'pending') {
      throw errors.conflict('MEMBER_NOT_PENDING', 'Це запрошення вже розглянуто')
    }

    // joinedAt — та сама дата, з якої нараховуються відсотки.
    const [updated] = await tx
      .update(businessMembers)
      .set({ status: 'active', joinedAt: new Date() })
      .where(eq(businessMembers.id, memberId))
      .returning()

    await tx.insert(memberRates).values({ id: newId('rat'), memberId, rateAnnualBps })

    // Прийняти запрошення — і означає віддати кошти в бізнес. Окремого кроку
    // «прийняти кошти» тут немає: людина не «вступає, а потім вкладає», вона
    // вступає саме тим, що вкладає.
    const swept = await sweepWallet(tx, updated!, userId, 'Автоматично при вступі')
    return { member: updated!, swept }
  })
}

/**
 * Відмова від запрошення.
 *
 * Рішення учасника, не власника: приймає його той, кого запросили. Нічого не
 * рухає — до прийняття кошти й не заходили, тож і повертати нема чого.
 * Запросити повторно можна: рядок оживає тим самим, разом з історією.
 */
export async function declineInvite(memberId: string, userId: string): Promise<Member> {
  const member = await memberFor(db, memberId)
  if (member.userId !== userId) throw errors.forbidden()
  if (member.status !== 'pending') {
    throw errors.conflict('MEMBER_NOT_PENDING', 'Це запрошення вже розглянуто')
  }

  const [row] = await db
    .update(businessMembers)
    .set({ status: 'declined', endedAt: new Date() })
    .where(eq(businessMembers.id, memberId))
    .returning()
  return row!
}

/**
 * Переносить кошти учасника в бізнес, якщо він у якомусь бізнесі є.
 *
 * Викликається і при вступі, і після поповнення гаманця: правило «кошти
 * учасника працюють у бізнесі» має триматися постійно, інакше воно було б
 * правдою рівно одну мить — у момент вступу.
 *
 * Дві активні участі одночасно розділити неможливо — у який з двох бізнесів
 * мали б піти гроші, не знає ніхто, — тож тоді кошти лишаються на гаманці й
 * чекають на рішення людини.
 */
export async function sweepIntoBusiness(
  tx: Tx,
  userId: string,
  actorId: string,
  reason = 'Поповнення гаманця',
) {
  const active = await tx
    .select()
    .from(businessMembers)
    .where(and(eq(businessMembers.userId, userId), eq(businessMembers.status, 'active')))
  if (active.length !== 1) return []
  return sweepWallet(tx, active[0]!, actorId, reason)
}

/**
 * Переносить увесь баланс гаманця учасника в бізнес — по одному рядку на
 * валюту, однією транзакцією.
 *
 * Проводка чотиристороння, бо гроші справді змінюють природу. Були записом на
 * платформі, стають готівкою бізнесу й боргом перед учасником:
 *
 *   гаманець −X   гроші пішли з платформи
 *   external +X   через межу системи — той самий рахунок, що й при поповненні
 *   готівка  +X   бізнес отримав кошти
 *   борг     −X   і став винен їх учаснику
 *
 * Кошти лягають у «готівку поза касами»: у яку саме касу їх покласти, вирішує
 * власник, і для цього вже є переміщення.
 */
async function sweepWallet(tx: Tx, member: Member, actorId: string, reason: string) {
  const balances = await tx
    .select({
      currency: accounts.currency,
      balance: sql<string>`COALESCE(${accountBalances.balance}, 0)`,
    })
    .from(accounts)
    .leftJoin(accountBalances, eq(accountBalances.accountId, accounts.id))
    .where(
      and(
        eq(accounts.ownerType, 'user'),
        eq(accounts.ownerId, member.userId),
        eq(accounts.kind, 'user_wallet'),
      ),
    )

  const moved = balances
    .map((row) => ({ currency: row.currency, amount: BigInt(row.balance) }))
    .filter((row) => row.amount > 0n)
  if (moved.length === 0) return []

  const entries: LedgerEntryInput[] = []
  for (const { currency, amount } of moved) {
    const wallet = await userWallet(member.userId, currency, tx)
    const boundary = await externalAccount(currency, tx)
    const cash = await businessCash(member.businessId, currency, tx)
    const claim = await memberClaim(member.id, currency, tx)

    entries.push(
      { accountId: wallet.id, currency, amount: -amount, entryType: 'contribution_in' },
      { accountId: boundary.id, currency, amount, entryType: 'contribution_in' },
      {
        accountId: cash.id,
        currency,
        amount,
        entryType: 'contribution_in',
        counterpartyId: member.userId,
      },
      { accountId: claim.id, currency, amount: -amount, entryType: 'contribution_in' },
    )
  }

  const posted = await postTransaction(
    {
      type: 'membership_funding',
      actorId,
      meta: { memberId: member.id, businessId: member.businessId },
      entries,
    },
    tx,
  )

  // Той самий слід в історії вкладів, що й у ручного запису — щоб «звідки
  // взялися ці гроші» читалося в одному місці, а не тільки в журналі.
  for (const { currency, amount } of moved) {
    await tx.insert(contributions).values({
      id: newId('con'),
      memberId: member.id,
      direction: 'in',
      currency,
      amount,
      status: 'accepted',
      note: reason,
      transactionId: posted.transactionId,
      decidedAt: new Date(),
      decidedBy: actorId,
    })
  }

  return moved
}

/**
 * Зміна ставки додає рядок, а не переписує старий: інакше нові умови тихо
 * переписали б уже нарахований відсоток за минулі місяці.
 */
export async function setRate(memberId: string, rateAnnualBps: number) {
  const [row] = await db
    .insert(memberRates)
    .values({ id: newId('rat'), memberId, rateAnnualBps })
    .returning()
  return row!
}

export async function currentRate(memberId: string, tx: DbOrTx = db) {
  const [row] = await tx
    .select()
    .from(memberRates)
    .where(and(eq(memberRates.memberId, memberId), sql`${memberRates.effectiveFrom} <= now()`))
    .orderBy(desc(memberRates.effectiveFrom))
    .limit(1)
  return row ?? null
}

/**
 * Вихід з бізнесу — з виплатою решти боргу.
 *
 * Те саме, що зняття, тільки всього одразу: борг гаситься, готівка бізнесу
 * зменшується, гроші йдуть людині в руки. Просто зняти статус, лишивши борг
 * висіти, не можна — це стерло б зобов'язання замість того, щоб його виконати.
 *
 * Гроші беруться з готівки поза касами. Якщо їх там уже немає — вони в касі
 * або витрачені, — операція падає з точною сумою, якої бракує: віддати те,
 * чого немає, додаток не вміє, і вигадувати за власника, з якої каси взяти,
 * тут не місце.
 */
export async function endMembership(memberId: string, ownerId: string) {
  return db.transaction(async (tx) => {
    const member = await memberFor(tx, memberId)
    await assertOwns(tx, member.businessId, ownerId)

    const owing = (await claimBalances(memberId, tx)).filter((row) => row.balance !== 0n)
    const returned: Array<{ currency: string; amount: Money }> = []

    if (owing.length > 0) {
      const entries: LedgerEntryInput[] = []
      for (const { currency, balance } of owing) {
        if (balance < 0n) {
          throw errors.conflict('MEMBER_OVERDRAWN', 'Від’ємний борг перед учасником', {
            member: currency,
          })
        }
        entries.push(
          ...(await payoutEntries(tx, member, currency, balance, 'Завершення участі')),
        )
        returned.push({ currency, amount: balance })
      }

      const posted = await postTransaction(
        {
          type: 'membership_closing',
          actorId: ownerId,
          meta: { memberId, businessId: member.businessId },
          entries,
        },
        tx,
      )

      for (const { currency, amount } of returned) {
        await tx.insert(contributions).values({
          id: newId('con'),
          memberId,
          direction: 'out',
          currency,
          amount,
          status: 'accepted',
          note: 'Виплата при завершенні участі',
          transactionId: posted.transactionId,
          decidedAt: new Date(),
          decidedBy: ownerId,
        })
      }
    }

    const [row] = await tx
      .update(businessMembers)
      .set({ status: 'ended', endedAt: new Date() })
      .where(eq(businessMembers.id, memberId))
      .returning()
    return { member: row!, returned }
  })
}

/**
 * Виплата учаснику: борг гаситься, готівка бізнесу зменшується.
 *
 * Гроші виходять із системи, бо власник віддає їх з рук у руки. Тому проводка
 * двостороння й не веде на гаманець: там лежать записи платформи, а тут —
 * купюри, і робити вигляд, що це те саме, означало б показати людині гроші,
 * яких у додатку вже немає.
 */
async function payoutEntries(
  tx: Tx,
  member: Member,
  currency: string,
  amount: Money,
  comment: string,
): Promise<LedgerEntryInput[]> {
  const cash = await businessCash(member.businessId, currency, tx)
  const claim = await memberClaim(member.id, currency, tx)

  // Журнал і сам не дасть піти в мінус, але скаже про це номером рахунку.
  // Людині потрібне інше: скільки бракує і що з цим робити.
  const available = await balanceOf(cash.id, tx)
  if (available < amount) {
    throw errors.conflict(
      'NOT_ENOUGH_CASH',
      `Не вистачає готівки: потрібно ${toMajor(amount, 2)} ${currency}, ` +
        `а поза касами є ${toMajor(available, 2)} ${currency}. ` +
        'Перемістіть кошти з каси в готівку і спробуйте ще раз.',
      { amount: currency },
    )
  }

  return [
    { accountId: claim.id, currency, amount, entryType: 'contribution_out', comment },
    {
      accountId: cash.id,
      currency,
      amount: -amount,
      entryType: 'contribution_out',
      counterpartyId: member.userId,
      comment,
    },
  ]
}

/**
 * Зняття коштів учасником.
 *
 * Підтвердження власника не потрібне: він і так фізично видає готівку з каси,
 * а додаток лише фіксує, що борг зменшився. Ставити тут ще одну галочку
 * означало б підтверджувати те, що вже сталося.
 */
export async function withdraw({
  memberId,
  userId,
  currency,
  amount,
  comment,
  idempotencyKey,
}: {
  memberId: string
  userId: string
  currency: string
  amount: string
  comment: string
  idempotencyKey?: string | null
}) {
  const value = parseAmount(amount)
  if (value <= 0n) throw errors.validation('Сума має бути більшою за нуль', { amount: 'мін. 0.01' })

  return db.transaction(async (tx) => {
    const member = await memberFor(tx, memberId)
    if (member.userId !== userId) throw errors.forbidden()
    if (member.status !== 'active') {
      throw errors.conflict('MEMBER_NOT_ACTIVE', 'Участь не активна')
    }

    const owed = (await claimBalances(memberId, tx)).find((row) => row.currency === currency)
    const available = owed?.balance ?? 0n
    if (value > available) {
      throw errors.conflict(
        'NOT_ENOUGH_FUNDS',
        `Забагато: у бізнесі ${toMajor(available, 2)} ${currency}`,
        { amount: 'більше, ніж є' },
      )
    }

    const posted = await postTransaction(
      {
        type: 'membership_withdrawal',
        idempotencyKey,
        actorId: userId,
        meta: { memberId, businessId: member.businessId },
        entries: await payoutEntries(tx, member, currency, value, comment),
      },
      tx,
    )

    await tx.insert(contributions).values({
      id: newId('con'),
      memberId,
      direction: 'out',
      currency,
      amount: value,
      status: 'accepted',
      note: comment,
      transactionId: posted.transactionId,
      decidedAt: new Date(),
      decidedBy: userId,
    })

    return posted
  })
}

/**
 * Прибрати учасника зі списку.
 *
 * Рядок лишається в базі: на ньому висять рахунки журналу й історія
 * надходжень, а проводки незмінні — видалення розірвало б книгу. Тому
 * ховається лише картка, і лише тоді, коли участь завершена й борг нульовий:
 * сховати того, кому бізнес винен, означало б забути про зобов'язання.
 */
export async function hideMembership(memberId: string, ownerId: string) {
  return db.transaction(async (tx) => {
    const member = await memberFor(tx, memberId)
    await assertOwns(tx, member.businessId, ownerId)

    if (member.status === 'active' || member.status === 'pending') {
      throw errors.conflict('MEMBER_STILL_ACTIVE', 'Спершу завершіть участь')
    }

    const owing = (await claimBalances(memberId, tx)).filter((row) => row.balance !== 0n)
    if (owing.length > 0) {
      throw errors.conflict('MEMBER_HAS_BALANCE', 'Учаснику ще не виплачено кошти', {
        member: owing.map((row) => row.currency).join(', '),
      })
    }

    const [row] = await tx
      .update(businessMembers)
      .set({ hiddenAt: new Date() })
      .where(eq(businessMembers.id, memberId))
      .returning()
    return row!
  })
}

/** Цей бізнес справді належить цьому власнику. */
async function assertOwns(tx: DbOrTx, businessId: string, ownerId: string) {
  const [row] = await tx
    .select({ id: businesses.id })
    .from(businesses)
    .where(and(eq(businesses.id, businessId), eq(businesses.ownerUserId, ownerId)))
    .limit(1)
  if (!row) throw errors.forbidden()
}

/**
 * Переказ між учасниками одного бізнесу.
 *
 * Каси не рухаються — гроші фізично лишаються там, де лежали. Змінюється лише
 * те, кому бізнес винен, тож для бізнесу підсумок нульовий. Саме тому це не
 * «переказ коштів», а передача вимоги.
 */
export async function transferClaim({
  memberId,
  userId,
  toUserId,
  currency,
  amount,
  comment,
  idempotencyKey,
}: {
  memberId: string
  userId: string
  toUserId: string
  currency: string
  amount: string
  comment?: string
  idempotencyKey?: string | null
}) {
  const value = parseAmount(amount)
  if (value <= 0n) throw errors.validation('Сума має бути більшою за нуль', { amount: 'мін. 0.01' })

  return db.transaction(async (tx) => {
    const from = await memberFor(tx, memberId)
    if (from.userId !== userId) throw errors.forbidden()
    if (from.status !== 'active') {
      throw errors.conflict('MEMBER_NOT_ACTIVE', 'Участь ще не активна')
    }
    if (toUserId === userId) {
      throw errors.validation('Не можна переказати самому собі', { toUserId: 'оберіть іншого' })
    }

    // Отримувач має бути учасником того самого бізнесу: переказ назовні — це
    // виведення готівки, а воно проходить підтвердженням власника, не тут.
    const [to] = await tx
      .select()
      .from(businessMembers)
      .where(
        and(
          eq(businessMembers.businessId, from.businessId),
          eq(businessMembers.userId, toUserId),
          eq(businessMembers.status, 'active'),
        ),
      )
      .limit(1)
    if (!to) {
      throw errors.validation('Отримувач не є учасником цього бізнесу', {
        toUserId: 'не учасник',
      })
    }

    const fromClaim = await memberClaim(from.id, currency, tx)
    const toClaim = await memberClaim(to.id, currency, tx)

    const posted = await postTransaction(
      {
        type: 'claim_transfer',
        idempotencyKey,
        actorId: userId,
        meta: { businessId: from.businessId, from: from.id, to: to.id },
        entries: [
          // Борг від'ємний, тож у відправника він рухається до нуля (+),
          // а в отримувача — від нуля (−).
          {
            accountId: fromClaim.id,
            currency,
            amount: value,
            entryType: 'claim_out',
            comment,
            counterpartyId: toUserId,
          },
          {
            accountId: toClaim.id,
            currency,
            amount: -value,
            entryType: 'claim_in',
            comment,
            counterpartyId: userId,
          },
        ],
      },
      tx,
    )
    return posted
  })
}

// ─── Читання ────────────────────────────────────────────────────────────────

/**
 * Залишки боргу перед учасником.
 *
 * У журналі вимога від'ємна — це зобов'язання. Назовні вона віддається
 * перевернутою, бо «бізнес винен вам 1 000» природніше читається додатним, а
 * знак — деталь бухгалтерії, не інтерфейсу.
 */
export async function claimBalances(memberId: string, tx: DbOrTx = db) {
  const rows = await tx
    .select({
      currency: accounts.currency,
      balance: sql<string>`COALESCE(${accountBalances.balance}, 0)`,
    })
    .from(accounts)
    .leftJoin(accountBalances, eq(accountBalances.accountId, accounts.id))
    .where(and(eq(accounts.ownerType, 'membership'), eq(accounts.ownerId, memberId)))
  return rows
    .map((r) => ({ currency: r.currency, balance: -BigInt(r.balance) }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
}

/** Список учасників бізнесу з боргом перед кожним. */
export async function listMembers(businessId: string) {
  const rows = await db
    .select({ member: businessMembers, user: users })
    .from(businessMembers)
    .innerJoin(users, eq(users.id, businessMembers.userId))
    .where(and(eq(businessMembers.businessId, businessId), isNull(businessMembers.hiddenAt)))
    .orderBy(businessMembers.invitedAt)

  return Promise.all(
    rows.map(async ({ member, user }) => ({
      ...member,
      displayName: user.displayName,
      email: user.email,
      rate: await currentRate(member.id),
      balances: await claimBalances(member.id),
    })),
  )
}

/** Участі цієї людини — у власному бізнесі їх зазвичай одна. */
export async function membershipsOf(userId: string) {
  const rows = await db
    .select({ member: businessMembers, business: businesses })
    .from(businessMembers)
    .innerJoin(businesses, eq(businesses.id, businessMembers.businessId))
    .where(eq(businessMembers.userId, userId))
    .orderBy(businessMembers.invitedAt)

  return Promise.all(
    rows.map(async ({ member, business }) => ({
      ...member,
      businessName: business.name,
      rate: await currentRate(member.id),
      balances: await claimBalances(member.id),
    })),
  )
}

/**
 * Історія надходжень. Тільки проведені: заявки з часів, коли внески
 * підтверджували руками, підтверджувати вже нікому — показувати їх як живі
 * означало б обіцяти дію, якої в додатку немає.
 */
export async function listContributions({
  businessId,
  memberId,
}: {
  businessId?: string
  memberId?: string
}) {
  const conditions = [eq(contributions.status, 'accepted')]
  if (memberId) conditions.push(eq(contributions.memberId, memberId))
  if (businessId) conditions.push(eq(businessMembers.businessId, businessId))

  const rows = await db
    .select({ contribution: contributions, member: businessMembers, user: users })
    .from(contributions)
    .innerJoin(businessMembers, eq(businessMembers.id, contributions.memberId))
    .innerJoin(users, eq(users.id, businessMembers.userId))
    .where(and(...conditions))
    .orderBy(desc(contributions.declaredAt))
    .limit(100)

  return rows.map(({ contribution, user }) => ({
    ...contribution,
    displayName: user.displayName,
  }))
}

/** Сумарний борг бізнесу перед усіма учасниками, у валюті звітності. */
export async function liabilitiesOf(businessId: string, target?: string | null) {
  const { toBase } = await valuationTable(target)
  const rows = await db
    .select({
      currency: accounts.currency,
      balance: sql<string>`COALESCE(${accountBalances.balance}, 0)`,
    })
    .from(accounts)
    .leftJoin(accountBalances, eq(accountBalances.accountId, accounts.id))
    .innerJoin(businessMembers, eq(businessMembers.id, accounts.ownerId))
    .where(
      and(eq(accounts.ownerType, 'membership'), eq(businessMembers.businessId, businessId)),
    )

  const byCurrency = new Map<string, Money>()
  let total = 0n
  for (const row of rows) {
    const owed = -BigInt(row.balance)
    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0n) + owed)
    total += toBase(owed, row.currency)
  }
  return { total, byCurrency }
}

// ─── Внутрішнє ──────────────────────────────────────────────────────────────

async function memberFor(tx: DbOrTx, memberId: string): Promise<Member> {
  const [row] = await tx
    .select()
    .from(businessMembers)
    .where(eq(businessMembers.id, memberId))
    .limit(1)
  if (!row) throw errors.notFound('Участь')
  return row
}
