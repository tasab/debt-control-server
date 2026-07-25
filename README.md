# debt-control-server

Backend for the P2P lending platform: Fastify 5 + Drizzle + Postgres.
Plans live in `docs/` (`PLATFORM_PLAN.md` — concept, `SERVER_PLAN.md` — this stack,
API contract in §2).

## Run

```bash
docker compose up -d      # Postgres on :5433
cp .env.example .env
npm install
npm run db:migrate
npm run seed              # demo users, currencies, fee policies, rates
npm run dev               # http://localhost:3001
```

Seeded logins (password `password123`):
`investor@debt.local`, `business@debt.local`, `admin@debt.local`.

## Test

```bash
npm test
```

Tests run against the local Postgres and truncate between cases, so they run
one file at a time. They cover the invariants the whole system rests on:
an unbalanced transaction is refused, balances cannot go negative under
concurrency, a repeated `Idempotency-Key` never posts twice, `Σ share_bps` is
always 10000, and a repayment splits to the kopiyka.

## Shape

```
src/
  money/      amount · ledger · balances · fees · valuation   ← all money logic
  fx/         providers/ · service (quote-lock) · job
  domain/     auth · transfers · businesses · requests · loans · stats · scoring
  routes/     thin: validate → domain → serialise
  plugins/    auth (cookie + capabilities guard) · errors
  jobs/       accrual · snapshots · reconcile · rate refresh
db/schema/    drizzle tables      db/migrations/   db/seeds/
```

Two rules worth keeping: `routes/` never touches Drizzle, and money moves only
through `money/ledger.js#postTransaction` — one `grep` proves it.
