/**
 * Postgres client (postgres.js).
 *
 * A single pooled `sql` instance is shared process-wide. postgres.js manages
 * the connection pool internally, so this instance is safe to import anywhere.
 *
 * Reminder for callers:
 *   - Inside `sql.begin(async (sql) => { ... })`, use the *callback's* `sql`
 *     so queries run on the transaction's connection.
 *   - JSONB columns are NOT auto-serialised from a bare `${obj}`. Wrap objects
 *     with `sql.json(obj)` (see postgres-audit.ts).
 */
import postgres, { type Sql } from "postgres";
import { config } from "./../config";

export function createSql(url: string = config.DATABASE_URL): Sql {
  return postgres(url, {
    max: 10,
    idle_timeout: 20,
    // Postgres NOTICEs (e.g. "table already exists", ivfflat low-recall hints)
    // are not errors and only add noise. Opt in with SPANOAI_DEBUG_SQL=1.
    onnotice: process.env.SPANOAI_DEBUG_SQL ? undefined : () => {},
  });
}

export const sql: Sql = createSql();

/** Close the pool cleanly (used on shutdown). */
export async function closeSql(instance: Sql = sql): Promise<void> {
  await instance.end({ timeout: 5 });
}
