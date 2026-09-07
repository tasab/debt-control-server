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
npm run seed              # currencies, fee policies, rates, one admin
npm run dev               # http://localhost:3001
```

The seed installs reference data and a single admin account —
`admin@gmail.com` / `Admin123` (override with `SEED_ADMIN_PASSWORD`). There is
no demo world: money only enters through an admin top-up (D1), so the admin is
what makes a fresh database usable, not a convenience.

## Sessions

Sessions do not expire on a timer: `sessions.expires_at` is NULL and the JWT
carries no `exp`. Signing out, rotation and `revoked_at` are what end a
session — time is not. Set `SESSION_TTL_DAYS` to a positive number to bring
back a fixed lifetime. Browsers still cap the cookie itself at 400 days, so it
is refreshed on the next sign-in after that.

## Typecheck

```bash
npm run typecheck
```

The server is TypeScript with **no build step**: Node 24 runs `.ts` files by
stripping the types. That is why `tsconfig.json` sets `erasableSyntaxOnly` —
enums, namespaces and parameter properties would need emitting, so tsc refuses
them here. Relative imports point at `.ts` for the same reason.

## Shape

```
src/
  types.ts    Money, ledger entries, Db/Tx, Fastify decorators
  money/      amount · ledger · balances · fees · valuation   ← all money logic
  fx/         providers/ · service (quote-lock) · job
  domain/     auth · transfers · businesses · members · shares · stats · admin
  routes/     thin: validate → domain → serialise
  plugins/    auth (cookie + capabilities guard) · errors
  jobs/       reconcile · rate refresh
db/schema/    drizzle tables      db/migrations/   db/seeds/
```

Two rules worth keeping: `routes/` never touches Drizzle, and money moves only
through `money/ledger.ts#postTransaction` — one `grep` proves it.
