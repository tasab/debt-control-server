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
  sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 30),

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
    source: process.env.RATE_SOURCE ?? 'hardcoded',
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

export function assertConfig() {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set (copy server/.env.example to server/.env)')
  }
  if (config.isProduction && config.jwtSecret.startsWith('dev-only')) {
    throw new Error('JWT_SECRET must be set in production')
  }
}
