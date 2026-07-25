import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users, auditLog } from '../../db/schema/index.js'
import { errors } from '../errors.js'
import { newId, parseAmount } from '../money/amount.js'
import { postTransaction } from '../money/ledger.js'
import { externalAccount, platformFee, userWallet } from '../money/accounts.js'
import { previewFee } from '../money/fees.js'

/**
 * A transfer is exactly one ledger transaction with three entries
 * (sender / recipient / platform fee). The fee is never a follow-up
 * transaction — that would allow "transfer succeeded, fee didn't".
 */
export async function transfer(
  { fromUserId, toUserId, currency, amount, comment, idempotencyKey },
  context = {},
) {
  const value = parseAmount(amount)
  if (value <= 0n) throw errors.validation('Сума має бути більшою за нуль', { amount: 'мін. 0.01' })
  if (fromUserId === toUserId) {
    throw errors.validation('Не можна переказати самому собі', { toUserId: 'оберіть іншого' })
  }

  const [recipient] = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.id, toUserId), isNull(users.deletedAt)))
    .limit(1)
  if (!recipient) throw errors.notFound('Отримувача')

  const quote = await previewFee({ kind: 'transfer', currency, amount: value })

  const result = await db.transaction(async (tx) => {
    const sender = await userWallet(fromUserId, currency, tx)
    const receiver = await userWallet(toUserId, currency, tx)
    const feeAccount = await platformFee(currency, tx)

    // Debit and credit differ by who absorbs the fee (§12: sender by default).
    const debit = quote.payer === 'sender' ? value + quote.fee : value
    const credit = quote.payer === 'sender' ? value : value - quote.fee

    const entries = [
      {
        accountId: sender.id,
        currency,
        amount: -debit,
        entryType: 'transfer_out',
        comment,
        counterpartyId: toUserId,
      },
      {
        accountId: receiver.id,
        currency,
        amount: credit,
        entryType: 'transfer_in',
        comment,
        counterpartyId: fromUserId,
      },
    ]
    if (quote.fee > 0n) {
      entries.push({
        accountId: feeAccount.id,
        currency,
        amount: quote.fee,
        entryType: 'fee',
        comment: 'комісія за переказ',
      })
    }

    const posted = await postTransaction(
      {
        type: 'transfer',
        idempotencyKey,
        actorId: fromUserId,
        meta: {
          fee: quote.fee.toString(),
          feePolicyId: quote.policyId,
          toUserId,
          currency,
        },
        entries,
      },
      tx,
    )

    if (!posted.replayed) {
      await tx.insert(auditLog).values({
        id: newId('aud'),
        actorId: fromUserId,
        action: 'transfer.create',
        entity: 'transaction',
        entityId: posted.transactionId,
        data: { toUserId, currency, amount: value.toString(), fee: quote.fee.toString() },
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      })
    }
    return posted
  })

  return { transactionId: result.transactionId, fee: quote.fee, replayed: result.replayed }
}

/**
 * Admin top-up (D1): the only legal way money enters the system, and it is
 * still balanced — `external` goes negative by exactly what the wallet gains.
 */
export async function topUp({ adminId, userId, currency, amount, comment, idempotencyKey }) {
  const value = parseAmount(amount)
  if (value <= 0n) throw errors.validation('Сума має бути більшою за нуль', { amount: 'мін. 0.01' })

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1)
  if (!user) throw errors.notFound('Користувача')

  return db.transaction(async (tx) => {
    const wallet = await userWallet(userId, currency, tx)
    const external = await externalAccount(currency, tx)

    const posted = await postTransaction(
      {
        type: 'topup',
        idempotencyKey,
        actorId: adminId,
        meta: { userId, currency },
        entries: [
          { accountId: external.id, currency, amount: -value, entryType: 'topup' },
          {
            accountId: wallet.id,
            currency,
            amount: value,
            entryType: 'topup',
            comment: comment ?? 'поповнення',
          },
        ],
      },
      tx,
    )

    if (!posted.replayed) {
      await tx.insert(auditLog).values({
        id: newId('aud'),
        actorId: adminId,
        action: 'admin.topup',
        entity: 'transaction',
        entityId: posted.transactionId,
        data: { userId, currency, amount: value.toString() },
      })
    }
    return posted
  })
}
