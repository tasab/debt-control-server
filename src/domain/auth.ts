import { hash, verify } from '@node-rs/argon2'
import { and, eq, isNull, ilike, or, ne, sql } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { sessions, users, currencies, auditLog } from '../../db/schema/index.ts'
import { config } from '../config.ts'
import { AppError, errors } from '../errors.ts'
import { newId } from '../money/amount.ts'
import { userWallet } from '../money/accounts.ts'
import type { Capability, RequestContext } from '../types.ts'

export type User = typeof users.$inferSelect
export type Session = typeof sessions.$inferSelect

const CAPABILITIES: Capability[] = ['invest', 'borrow']

export async function register(
  {
    email,
    password,
    displayName,
    capability,
  }: { email: string; password: string; displayName: string; capability: Capability },
  context: RequestContext = {},
): Promise<User> {
  const normalizedEmail = email.trim().toLowerCase()
  if (!CAPABILITIES.includes(capability)) {
    throw errors.validation('Оберіть режим роботи', { capability: 'invest або borrow' })
  }

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1)
  if (existing) {
    throw new AppError('EMAIL_TAKEN', 'Ця пошта вже зареєстрована', {
      status: 409,
      fields: { email: 'вже зареєстрована' },
    })
  }

  const passwordHash = await hash(password)
  const user = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({
        id: newId('usr'),
        email: normalizedEmail,
        passwordHash,
        displayName: displayName.trim(),
        capabilities: [capability],
      })
      .returning()

    // Wallets exist from minute one so the ledger never has to create accounts
    // mid-transfer (and so GET /wallets is never an empty screen).
    const active = await tx.select().from(currencies).where(eq(currencies.isActive, true))
    for (const currency of active) {
      await userWallet(created.id, currency.code, tx)
    }

    await tx.insert(auditLog).values({
      id: newId('aud'),
      actorId: created.id,
      action: 'user.register',
      entity: 'user',
      entityId: created.id,
      data: { capability },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    })
    return created
  })

  return user
}

export async function login(
  { email, password }: { email: string; password: string },
  context: RequestContext = {},
): Promise<{ user: User; session: Session }> {
  const normalizedEmail = email.trim().toLowerCase()
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, normalizedEmail), isNull(users.deletedAt)))
    .limit(1)

  // Same error for unknown email and wrong password — no user enumeration.
  const invalid = new AppError('INVALID_CREDENTIALS', 'Невірна пошта або пароль', { status: 401 })
  if (!user) {
    // Constant-ish work even when the user is missing, so timing does not leak.
    await hash(password)
    throw invalid
  }
  const ok = await verify(user.passwordHash, password).catch(() => false)
  if (!ok) throw invalid

  const session = await createSession(user.id, context)
  return { user, session }
}

/**
 * Коли сесія спливає — або не спливає ніколи.
 *
 * `sessionTtlDays: 0` дає NULL, і перевірка часу в resolveUser просто не
 * спрацьовує. Одне місце на весь код, щоб «вічність» не розповзлася по трьох
 * різних формулах.
 */
const sessionExpiry = () =>
  config.sessionTtlDays > 0
    ? new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000)
    : null

export async function createSession(
  userId: string,
  context: RequestContext = {},
): Promise<Session> {
  const expiresAt = sessionExpiry()
  const [session] = await db
    .insert(sessions)
    .values({
      id: newId('ses'),
      userId,
      expiresAt,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    })
    .returning()
  return session
}

/**
 * Refresh rotation: the old session is revoked and points at its successor, so
 * a stolen cookie replayed after rotation resolves to a revoked row.
 */
export async function rotateSession(
  sessionId: string,
  context: RequestContext = {},
): Promise<Session> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
      .limit(1)
    if (!current) throw errors.unauthorized()

    const expiresAt = sessionExpiry()
    const [next] = await tx
      .insert(sessions)
      .values({
        id: newId('ses'),
        userId: current.userId,
        expiresAt,
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      })
      .returning()

    await tx
      .update(sessions)
      .set({ revokedAt: new Date(), rotatedTo: next.id })
      .where(eq(sessions.id, sessionId))
    return next
  })
}

export async function logout(sessionId: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId))
}

/** Public search for a transfer recipient — public fields only. */
export async function searchUsers({
  query,
  excludeUserId,
  limit = 50,
}: {
  query: string
  excludeUserId?: string
  limit?: number
}) {
  // Без запиту повертається весь список — це той самий набір людей, який
  // однаково знайшовся б пошуком по двох літерах, тож нічого нового назовні
  // не виходить, зате отримувача можна просто вибрати зі списку.
  const term = `%${query.trim()}%`
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(
      and(
        isNull(users.deletedAt),
        excludeUserId ? ne(users.id, excludeUserId) : sql`true`,
        query.trim() ? or(ilike(users.displayName, term), ilike(users.email, term)) : sql`true`,
      ),
    )
    .orderBy(users.displayName)
    .limit(limit)

  // Email is masked: enough to disambiguate two people with the same name,
  // not enough to harvest addresses.
  return rows.map((r) => ({ id: r.id, displayName: r.displayName, hint: maskEmail(r.email) }))
}

function maskEmail(email: string): string {
  const [name, domain] = email.split('@')
  const head = name.slice(0, 2)
  return `${head}${'•'.repeat(Math.max(name.length - 2, 1))}@${domain}`
}
