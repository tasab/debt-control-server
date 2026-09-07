import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db/index.ts'
import {
  auditLog,
  businessMembers,
  businesses,
  sessions,
  transactions,
  users,
} from '../../db/schema/index.ts'
import { errors } from '../errors.ts'
import { newId, parseAmount } from '../money/amount.ts'
import { postTransaction } from '../money/ledger.ts'
import {
  businessIncome,
  externalAccount,
  memberClaim,
  userWallet,
} from '../money/accounts.ts'
import { availableBalance, balanceOf, walletsForUser } from '../money/balances.ts'
import { membershipsOf, sweepIntoBusiness } from './members.ts'
import type { LedgerEntryInput, Money, RequestContext } from '../types.ts'

/**
 * Admin editing of participants' accounts (D1: the platform is the only source
 * of money, and an admin is the only one who may create or remove it).
 *
 * A balance is not a field — it is the sum of an immutable ledger. So «змінити
 * рахунок» is posted as a normal balanced transaction against `external`,
 * exactly like a top-up: the wallet moves by the delta, `external` absorbs the
 * mirror image, and the ledger still sums to zero. An UPDATE on
 * account_balances would leave the entries and the balance disagreeing, and the
 * reconciliation job would (rightly) start screaming.
 *
 * Only the spendable wallet is editable. Held money belongs to a funding offer
 * that is still open — releasing it behind the escrow's back would leave a
 * request half-funded with nothing behind it.
 */

export type AdjustMode = 'set' | 'credit' | 'debit'

export interface ParticipantView {
  id: string
  email: string
  displayName: string
  capabilities: string[]
  isAdmin: boolean
  businessName: string | null
  wallets: Array<{ currency: string; available: Money; held: Money; total: Money }>
  // Кошти учасника лежать не на гаманці, а в бізнесі — без цього поля адмін
  // бачив би самі нулі там, де насправді є гроші.
  invested: Array<{ memberId: string; currency: string; amount: Money; businessName: string }>
}

/** Everyone on the platform, with every currency they hold — including UAH. */
export async function listParticipants({
  query,
  limit = 50,
}: { query?: string; limit?: number } = {}): Promise<ParticipantView[]> {
  const conditions = [isNull(users.deletedAt)]
  if (query?.trim()) {
    const pattern = `%${query.trim()}%`
    conditions.push(or(ilike(users.displayName, pattern), ilike(users.email, pattern))!)
  }

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      capabilities: users.capabilities,
      isAdmin: users.isAdmin,
      businessName: businesses.name,
    })
    .from(users)
    .leftJoin(businesses, eq(businesses.ownerUserId, users.id))
    .where(and(...conditions))
    .orderBy(asc(users.displayName), asc(users.id))
    .limit(limit)

  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      capabilities: row.capabilities ?? [],
      businessName: row.businessName ?? null,
      invested: await investedOf(row.id),
      wallets: await walletsForUser(row.id),
    })),
  )
}

/**
 * Set, add to, or take from a participant's wallet in one currency.
 *
 * `set` is the honest form of «відредагувати рахунок»: the admin names the
 * balance they want and the server works out the delta, so two admins editing
 * the same wallet cannot silently double an increment they both meant once.
 * Taking money out is bounded by the ledger's non-negativity rule — the wallet
 * cannot be pushed below zero, and held money is out of reach entirely.
 */
export async function adjustBalance(
  {
    adminId,
    userId,
    currency,
    mode,
    amount,
    comment,
    memberId,
    idempotencyKey,
  }: {
    adminId: string
    userId: string
    currency: string
    mode: AdjustMode
    amount: string
    comment: string
    /** Правимо не гаманець, а борг бізнесу перед цим учасником. */
    memberId?: string | null
    idempotencyKey?: string | null
  },
  context: RequestContext = {},
): Promise<{
  transactionId: string
  replayed: boolean
  swept: Array<{ currency: string; amount: Money }>
  before: Money
  after: Money
  delta: Money
}> {
  // `set` may legitimately name zero — emptying an account is an edit like any
  // other. `credit`/`debit` may not: a move of nothing is not a correction.
  const value = parseAmount(amount, { field: 'amount' })
  if (mode !== 'set' && value <= 0n) {
    throw errors.validation('Сума має бути більшою за нуль', { amount: 'мін. 0.01' })
  }

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1)
  if (!user) throw errors.notFound('Користувача')

  // Борг бізнесу перед учасником живе від'ємним, але правиться так само, як
  // гаманець: адмін вводить «скільки має бути», а знак — деталь журналу.
  const membership = memberId ? await memberOf(memberId, userId) : null

  return db.transaction(async (tx) => {
    const target = membership
      ? await memberClaim(membership.id, currency, tx)
      : await userWallet(userId, currency, tx)
    const external = await externalAccount(currency, tx)

    // Read the balance inside the transaction. postTransaction locks both
    // accounts and re-checks, so a concurrent transfer cannot slip between the
    // delta being computed and being applied without being noticed.
    const before = membership
      ? -(await balanceOf(target.id, tx))
      : await availableBalance(userId, currency, tx)
    const delta = mode === 'set' ? value - before : mode === 'credit' ? value : -value
    if (delta === 0n) {
      throw errors.validation('Баланс уже такий — змінювати нічого', {
        amount: 'оберіть інше значення',
      })
    }

    const posted = await postTransaction(
      {
        type: 'adjustment',
        idempotencyKey,
        actorId: adminId,
        meta: {
          userId,
          currency,
          mode,
          memberId: membership?.id ?? null,
          before: before.toString(),
          after: (before + delta).toString(),
          comment,
        },
        entries: [
          // Для боргу знак протилежний: більший борг — це «глибший мінус».
          // Зустрічний рядок мусить дзеркалити саме його, інакше транзакція
          // не сходиться в нуль.
          {
            accountId: external.id,
            currency,
            amount: membership ? delta : -delta,
            entryType: 'adjustment',
            comment,
          },
          {
            accountId: target.id,
            currency,
            amount: membership ? -delta : delta,
            entryType: 'adjustment',
            counterpartyId: adminId,
            comment,
          },
        ],
      },
      tx,
    )

    if (!posted.replayed) {
      // Editing someone else's money is exactly the action that must never be
      // untraceable: who, whom, from what to what, and why.
      await tx.insert(auditLog).values({
        id: newId('aud'),
        actorId: adminId,
        action: 'admin.adjust',
        entity: 'transaction',
        entityId: posted.transactionId,
        data: {
          userId,
          currency,
          mode,
          before: before.toString(),
          after: (before + delta).toString(),
          delta: delta.toString(),
          comment,
        },
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      })
    }

    // Гаманець активного учасника — не місце, де гроші лежать: вони працюють
    // у бізнесі. Тож поповнення через коригування йде туди ж, куди пішло б
    // будь-яке інше, і «after» показує те, що справді лишилось на рахунку, а
    // не проміжний стан, якого вже немає.
    const swept =
      !membership && delta > 0n
        ? await sweepIntoBusiness(tx, userId, adminId, 'Коригування балансу')
        : []
    const after = swept.length > 0 ? await availableBalance(userId, currency, tx) : before + delta


    return {
      transactionId: posted.transactionId,
      replayed: posted.replayed,
      swept,
      before,
      after,
      delta,
    }
  })
}

/** Участь, яка справді належить цьому користувачеві. */
async function memberOf(memberId: string, userId: string) {
  const [row] = await db
    .select({ id: businessMembers.id })
    .from(businessMembers)
    .where(and(eq(businessMembers.id, memberId), eq(businessMembers.userId, userId)))
    .limit(1)
  if (!row) throw errors.notFound('Участь')
  return row
}

/** Скільки в людини лежить у бізнесах, по валютах. */
async function investedOf(userId: string) {
  const memberships = await membershipsOf(userId)
  return memberships
    .filter((m) => m.status === 'active')
    .flatMap((m) =>
      m.balances
        .filter((row) => row.balance !== 0n)
        .map((row) => ({
          memberId: m.id,
          currency: row.currency,
          amount: row.balance,
          businessName: m.businessName,
        })),
    )
}

/**
 * Видалення користувача адміном.
 *
 * М'яке: рядок лишається, бо на ньому висять проводки журналу, а вони
 * незмінні. Ставиться `deleted_at`, і людина зникає зі списків та не може
 * увійти — активні сесії обриваються тут же, інакше вона ще годинами
 * користувалася б додатком з уже виданим токеном.
 *
 * За замовчуванням видалити можна лише того, за ким не лишилося грошей: інакше
 * зникла б людина, а зобов'язання перед нею — ні. `force` знімає це
 * обмеження й дописує залишки:
 *
 *   гаманець → external   гроші виходять із системи, як при виплаті готівкою
 *   борг      → виторг    бізнес більше не винен — прощений борг це його дохід
 *
 * Обидва боки лишаються в журналі проводкою з поясненням, тож «кудиділися ті
 * 12 000» матиме відповідь і через рік. Сума журналу, як завжди, нульова.
 */
export async function deleteParticipant(
  { adminId, userId, force = false }: { adminId: string; userId: string; force?: boolean },
  context: RequestContext = {},
) {
  if (adminId === userId) {
    throw errors.validation('Не можна видалити самого себе', { userId: 'це ви' })
  }

  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1)
  if (!user) throw errors.notFound('Користувача')

  // Бізнес — не «залишок на рахунку», а ціла структура з касами, учасниками
  // й боргами перед ними. Осиротити її мовчки не можна навіть із force.
  const [ownedBusiness] = await db
    .select({ id: businesses.id, name: businesses.name })
    .from(businesses)
    .where(eq(businesses.ownerUserId, userId))
    .limit(1)
  if (ownedBusiness) {
    throw errors.conflict('USER_OWNS_BUSINESS', `У користувача є бізнес «${ownedBusiness.name}»`)
  }

  const wallets = await walletsForUser(userId)
  const funded = wallets.filter((w) => w.available !== 0n)
  const memberships = await membershipsOf(userId)
  const owed = memberships.filter((m) => m.balances.some((row) => row.balance !== 0n))

  if (!force) {
    if (funded.length > 0) {
      throw errors.conflict('USER_HAS_FUNDS', 'На гаманці ще є кошти', {
        userId: funded.map((w) => w.currency).join(', '),
      })
    }
    if (owed.length > 0 || memberships.some((m) => m.status === 'active')) {
      throw errors.conflict('USER_IN_BUSINESS', 'Користувач ще бере участь у бізнесі', {
        userId: memberships.map((m) => m.businessName).join(', '),
      })
    }
  }

  return db.transaction(async (tx) => {
    const now = new Date()
    const reason = `Списано при видаленні користувача ${user.displayName}`
    const writtenOff: Array<{ currency: string; amount: Money; source: string }> = []

    if (force) {
      const entries: LedgerEntryInput[] = []

      for (const wallet of funded) {
        const account = await userWallet(userId, wallet.currency, tx)
        const boundary = await externalAccount(wallet.currency, tx)
        entries.push(
          {
            accountId: account.id,
            currency: wallet.currency,
            amount: -wallet.available,
            entryType: 'adjustment',
            comment: reason,
          },
          {
            accountId: boundary.id,
            currency: wallet.currency,
            amount: wallet.available,
            entryType: 'adjustment',
            comment: reason,
          },
        )
        writtenOff.push({ currency: wallet.currency, amount: wallet.available, source: 'гаманець' })
      }

      for (const membership of memberships) {
        for (const row of membership.balances) {
          if (row.balance === 0n) continue
          const claim = await memberClaim(membership.id, row.currency, tx)
          const income = await businessIncome(membership.businessId, row.currency, tx)
          entries.push(
            {
              accountId: claim.id,
              currency: row.currency,
              amount: row.balance,
              entryType: 'adjustment',
              comment: reason,
            },
            {
              accountId: income.id,
              currency: row.currency,
              amount: -row.balance,
              entryType: 'adjustment',
              comment: reason,
            },
          )
          writtenOff.push({
            currency: row.currency,
            amount: row.balance,
            source: membership.businessName,
          })
        }
      }

      if (entries.length > 0) {
        await postTransaction(
          { type: 'user_deletion', actorId: adminId, meta: { userId }, entries },
          tx,
        )
      }

      // Участі закриваються тут же: людини вже немає, і лишати її активною
      // означало б показувати бізнесу учасника, якого не існує.
      await tx
        .update(businessMembers)
        .set({ status: 'ended', endedAt: now, hiddenAt: now })
        .where(eq(businessMembers.userId, userId))
    }

    await tx.update(users).set({ deletedAt: now }).where(eq(users.id, userId))
    // Токен живе своїм життям, поки сесія не відкликана.
    await tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))

    await tx.insert(auditLog).values({
      id: newId('aud'),
      actorId: adminId,
      action: 'admin.delete_user',
      entity: 'user',
      entityId: userId,
      data: {
        email: user.email,
        displayName: user.displayName,
        force,
        writtenOff: writtenOff.map((row) => ({
          currency: row.currency,
          amount: row.amount.toString(),
          source: row.source,
        })),
      },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    })

    return { ok: true, writtenOff }
  })
}

/** The trail behind one participant's balances: adjustments and top-ups. */
export async function participantAdjustments(userId: string, limit = 20) {
  const rows = await db
    .select({
      id: transactions.id,
      type: transactions.type,
      meta: transactions.meta,
      actorId: transactions.actorId,
      actorName: users.displayName,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .leftJoin(users, eq(users.id, transactions.actorId))
    .where(
      and(
        sql`${transactions.type} IN ('adjustment', 'topup')`,
        sql`${transactions.meta}->>'userId' = ${userId}`,
      ),
    )
    .orderBy(desc(transactions.createdAt))
    .limit(limit)
  return rows
}
