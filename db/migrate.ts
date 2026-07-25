import 'dotenv/config'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

// Applies every generated migration in db/migrations. Run with `npm run db:migrate`
// after `npm run db:generate`. Idempotent — already-applied migrations are skipped.
const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const db = drizzle(pool)

await migrate(db, { migrationsFolder: './db/migrations' })
await pool.end()
console.log('Migrations applied.')
