import { pgTable, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { amount, users } from './core.ts'
import { businesses } from './business.ts'
import type { ContributionDirection, ContributionStatus, MemberStatus } from '../../src/types.ts'

/**
 * Участь у бізнесі (PLATFORM_PLAN, модель вкладів).
 *
 * Прив'язка тут — людина до бізнесу, а не окрема позика: щойно учасник
 * активний, усі його кошти працюють у бізнесі, і борг бізнесу перед ним — це
 * просто залишок його рахунку. Ніяких заявок, часток і графіків погашення.
 *
 * Власник запрошує зі списку користувачів, учасник приймає й називає свою
 * ставку. `joinedAt` ставиться в момент прийняття — з нього ж рахуються
 * відсотки.
 */
export const businessMembers = pgTable(
  'business_members',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').$type<MemberStatus>().notNull().default('pending'),
    invitedAt: timestamp('invited_at', { withTimezone: true }).notNull().defaultNow(),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    // Прибраний зі списку, але не з бази: на цій участі висять рахунки
    // журналу й історія надходжень, а проводки незмінні. Тому «видалити»
    // означає сховати — і лише тоді, коли боргу вже немає.
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
  },
  (t) => [
    // Одна участь на пару: повторне запрошення має оновлювати наявний рядок,
    // а не плодити другий борг перед тією самою людиною.
    uniqueIndex('idx_members_pair').on(t.businessId, t.userId),
    index('idx_members_user').on(t.userId),
  ],
)

// Ставка датована, як і стартовий капітал: зміна додає рядок, а не переписує
// старий. Інакше зміна ставки заднім числом тихо переписала б уже нарахований
// відсоток, і історичний прибуток перестав би відтворюватись.
export const memberRates = pgTable(
  'member_rates',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => businessMembers.id),
    rateAnnualBps: integer('rate_annual_bps').notNull().default(0),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_member_rates_member').on(t.memberId, t.effectiveFrom)],
)

/**
 * Рух вкладу в обидва боки, з підтвердженням власника.
 *
 * Заявка учасника **не потрапляє в журнал**, доки власник не підтвердив, що
 * гроші справді прийняті (або справді віддані). Тому книга завжди дорівнює
 * тому, що лежить у касі: стану «сказав, що вніс, а гроші ще їдуть» не існує.
 * `transactionId` заповнюється рівно в момент підтвердження — незаповнений
 * означає гроші, яких ще немає.
 */
export const contributions = pgTable(
  'contributions',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => businessMembers.id),
    direction: text('direction').$type<ContributionDirection>().notNull(),
    currency: text('currency').notNull(),
    amount: amount('amount').notNull(),
    status: text('status').$type<ContributionStatus>().notNull().default('pending'),
    note: text('note'),
    // Куди фізично лягла (або звідки пішла) готівка — каса чи готівка поза
    // касами. Заповнює власник у момент підтвердження.
    targetAccountId: text('target_account_id'),
    transactionId: text('transaction_id'),
    declaredAt: timestamp('declared_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: text('decided_by').references(() => users.id),
  },
  (t) => [
    index('idx_contributions_member').on(t.memberId, t.declaredAt),
    index('idx_contributions_status').on(t.status, t.declaredAt),
  ],
)
