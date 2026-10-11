import { migrate, type Db } from "./db";

/** DATABASE_URL -> Postgres via node-postgres; otherwise an in-memory PGlite (development only). */
export async function openDb(env = process.env): Promise<Db> {
  let db: Db;
  if (env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    db = new pg.Pool({ connectionString: env.DATABASE_URL, max: Number(env.PG_POOL_MAX ?? 10) }) as unknown as Db;
  } else {
    if (env.NODE_ENV === "production") throw new Error("DATABASE_URL is required in production");
    const { PGlite } = await import("@electric-sql/pglite");
    db = new PGlite() as unknown as Db;
  }
  await migrate(db);
  return db;
}
