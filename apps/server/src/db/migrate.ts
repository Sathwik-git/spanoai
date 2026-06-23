/**
 * Migration runner.
 *
 * Applies every `*.sql` file in `migrations/` exactly once, in lexical order,
 * recording each in a `schema_migrations` ledger. Migrations are written to be
 * idempotent (IF NOT EXISTS / CREATE OR REPLACE) so an interrupted run is safe
 * to retry.
 *
 * Multi-statement files are sent over the *simple* protocol (`.simple()`),
 * which postgres.js wraps in an implicit transaction, so a file either fully
 * applies or not at all.
 *
 * Run as a CLI:  bun run src/db/migrate.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "postgres";
import { sql as defaultSql, closeSql } from "./client";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

export async function runMigrations(db: Sql = defaultSql): Promise<string[]> {
  await db`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const appliedRows = await db<{ version: string }[]>`
    SELECT version FROM schema_migrations
  `;
  const applied = new Set(appliedRows.map((r) => r.version));

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;

    const ddl = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
    console.log(`→ applying ${file}`);

    // `.simple()` => simple protocol, allowing multiple `;`-separated
    // statements; Postgres runs them inside one implicit transaction.
    await db.unsafe(ddl).simple();
    await db`INSERT INTO schema_migrations (version) VALUES (${file})`;

    newlyApplied.push(file);
    console.log(`✓ ${file}`);
  }

  if (newlyApplied.length === 0) {
    console.log("✓ database is up to date (no pending migrations)");
  } else {
    console.log(`✓ applied ${newlyApplied.length} migration(s)`);
  }
  return newlyApplied;
}

if (import.meta.main) {
  runMigrations()
    .then(() => closeSql())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("✗ migration failed:", err);
      void closeSql().finally(() => process.exit(1));
    });
}
