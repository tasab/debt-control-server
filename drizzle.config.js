import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

// drizzle-kit reads this to generate/apply migrations. Schema lives in db/schema,
// generated SQL migrations land in db/migrations — kept separate from src/.
export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema/index.js',
  out: './db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
})
