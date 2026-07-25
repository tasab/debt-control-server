import 'dotenv/config'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '../../db/schema/index.ts'

// Single pg connection pool + Drizzle client for the whole server. Schema lives
// in ../../db/schema; migrations are applied separately (npm run db:migrate).
const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Copy server/.env.example to server/.env ' +
      '(and run `docker compose up -d` for a local Postgres).',
  )
}

const { Pool } = pg

// pg returns bigint (int8) as a string by default to avoid precision loss.
// Drizzle's `mode: 'bigint'` columns handle the conversion, so leave the parser
// alone — turning int8 into Number here is exactly the bug this codebase avoids.
export const pool = new Pool({ connectionString })
export const db = drizzle(pool, { schema })
