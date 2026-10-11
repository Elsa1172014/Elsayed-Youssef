import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Minimal query interface satisfied by both node-postgres Pool and PGlite. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec?(sql: string): Promise<unknown>;
}

// MIGRATIONS_DIR lets serverless bundles (Vercel) point at a copy of the SQL files shipped with the function.
const migrationsDir = () => process.env.MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Applies migrations/*.sql in filename order, once each. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(migrationsDir()).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(migrationsDir(), file), "utf8");
    if (db.exec) await db.exec(sql);
    else await db.query(sql); // pg simple-query protocol allows multiple statements when no params are given
    await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    applied.push(file);
  }
  return applied;
}
