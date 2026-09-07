import 'dotenv/config'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '../../db/schema/index.ts'
import { assertConfig, config } from '../config.ts'

// Single pg connection pool + Drizzle client for the whole server. Schema lives
// in ../../db/schema; migrations are applied separately (npm run db:migrate).
//
// Перевірка стоїть тут, а не тільки в index.ts: імпорти обчислюються раніше за
// тіло модуля, тож цей файл — реально перше місце, куди доходить керування, і
// саме його повідомлення бачить той, хто читає логи деплою.
assertConfig()

const connectionString = config.databaseUrl!

const { Pool } = pg

// pg returns bigint (int8) as a string by default to avoid precision loss.
// Drizzle's `mode: 'bigint'` columns handle the conversion, so leave the parser
// alone — turning int8 into Number here is exactly the bug this codebase avoids.
export const pool = new Pool({ connectionString })
export const db = drizzle(pool, { schema })
