import 'dotenv/config'

const int = (value: string | undefined, fallback: number) =>
  value === undefined ? fallback : Number.parseInt(value, 10)

export const config = {
  port: int(process.env.PORT, 3001),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL,
  isProduction: process.env.NODE_ENV === 'production',

  // Dev default keeps `npm run dev` working after a fresh clone; production
  // refuses to start without a real secret (see assertConfig below).
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me',
  // 0 — сесія не спливає за часом узагалі. Розлогінити може лише сама людина
  // («Вийти»), ротація або адміністратор: час перестав бути причиною.
  // SESSION_TTL_DAYS=30 повертає старий строк, якщо колись знадобиться.
  sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 0),

  baseCurrency: process.env.BASE_CURRENCY ?? 'UAH',

  // Fee defaults (§12: 0.5% transfer, 10% of investor interest). These seed
  // fee_policies; runtime always reads the dated policy, never these constants.
  fees: {
    transferPercentBps: int(process.env.FEE_TRANSFER_BPS, 50),
    transferMin: BigInt(process.env.FEE_TRANSFER_MIN ?? '100'),
    transferMax: BigInt(process.env.FEE_TRANSFER_MAX ?? '5000'),
    interestShareBps: int(process.env.FEE_INTEREST_SHARE_BPS, 1000),
    originationBps: int(process.env.FEE_ORIGINATION_BPS, 0),
  },

  fx: {
    // Курси беруться з живого агрегатора; RATE_SOURCE=hardcoded лишається
    // тільки для офлайн-демо і тестів.
    source: process.env.RATE_SOURCE ?? 'external',
    apiUrl:
      process.env.RATE_API_URL ??
      'https://rate-agg-server-production.up.railway.app/share/8?rateType=SOURCE_RATE',
    quoteTtlSeconds: int(process.env.FX_QUOTE_TTL_SECONDS, 60),
    staleAfterMinutes: int(process.env.FX_STALE_AFTER_MINUTES, 120),
    refreshIntervalMinutes: int(process.env.FX_REFRESH_MINUTES, 15),
    // A new quote further than this from the previous one is rejected as a bad
    // feed rather than applied (PLATFORM_PLAN §3.3).
    maxJumpBps: int(process.env.FX_MAX_JUMP_BPS, 1500),
  },

  jobs: {
    enabled: process.env.JOBS_ENABLED !== '0',
  },
}

/**
 * Одна перевірка на весь запуск — і одне повідомлення з усім, чого бракує.
 *
 * Раніше DATABASE_URL перевірявся в db/index.ts, а JWT_SECRET — тут, і що
 * гірше, модуль бази обчислюється раніше за тіло index.ts, тож до перевірки
 * секрету справа не доходила взагалі. На хостингу це означало два деплої
 * поспіль: полагодив одну змінну — впав на наступній.
 *
 * Порада теж залежить від того, де це сталося: у контейнері «скопіюйте
 * .env.example» — марна витрата уваги, там змінні задає панель хостингу.
 */
export function assertConfig() {
  const missing: string[] = []

  if (!config.databaseUrl) missing.push('DATABASE_URL')
  if (config.isProduction && config.jwtSecret.startsWith('dev-only')) missing.push('JWT_SECRET')

  if (missing.length === 0) return

  // NODE_ENV=production — ознака хостингу; локально його немає.
  const hint = config.isProduction
    ? 'Задайте ці змінні в налаштуваннях сервісу. На Railway база дає свій ' +
      'DATABASE_URL: у змінних застосунку пропишіть посилання ' +
      'DATABASE_URL=${{Postgres.DATABASE_URL}}, а JWT_SECRET згенеруйте ' +
      '(`openssl rand -base64 32`) — на дефолтному сервер працювати відмовиться.'
    : 'Скопіюйте server/.env.example у server/.env і підніміть базу: ' +
      '`docker compose up -d`.'

  throw new Error(`Не задано: ${missing.join(', ')}. ${hint}`)
}
