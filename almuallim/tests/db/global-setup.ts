import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:54329/postgres";
export const TEST_DB = "almuallim_test";

export default async function setup() {
  const admin = new Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (e) {
    throw new Error(
      `Cannot reach test PostgreSQL at ${ADMIN_URL}. Start one with scripts/test-db-cluster.sh start ` +
        `(needs postgresql-16 + postgresql-16-pgvector) or set TEST_DATABASE_URL. Cause: ${(e as Error).message}`,
    );
  }
  await admin.query(`drop database if exists ${TEST_DB} with (force)`);
  await admin.query(`create database ${TEST_DB}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  const db = new Client({ connectionString: url.toString() });
  await db.connect();
  await db.query(readFileSync(join(__dirname, "supabase-stub.sql"), "utf8"));
  const dir = join(__dirname, "../../supabase/migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.query(readFileSync(join(dir, f), "utf8"));
  }
  await db.end();
  process.env.TEST_DB_URL = url.toString();
}
