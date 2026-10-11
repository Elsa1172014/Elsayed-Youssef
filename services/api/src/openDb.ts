import { migrate, type Db } from "./db";

/** Connection string: DATABASE_URL, else POSTGRES_URL, else a prefixed variable created by the Vercel/Neon integration
 *  (e.g. STORAGE_URL, STORAGE_DATABASE_URL, STORAGE_POSTGRES_URL). Pooled URLs win over unpooled/direct ones. */
export function databaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.POSTGRES_URL) return env.POSTGRES_URL;
  const isPg = (v: string | undefined): v is string => !!v && /^postgres(ql)?:\/\//.test(v);
  const keys = Object.keys(env).filter((k) => /(_DATABASE_URL|_POSTGRES_URL|^STORAGE_URL|_URL)$/.test(k) && !/(UNPOOLED|NON_POOLING|NO_SSL|PRISMA)/.test(k) && isPg(env[k]));
  keys.sort((a, b) => Number(/(DATABASE_URL|POSTGRES_URL)$/.test(b)) - Number(/(DATABASE_URL|POSTGRES_URL)$/.test(a)));
  return keys.length ? env[keys[0]!] : undefined;
}

/** DATABASE_URL -> Postgres via node-postgres; otherwise an in-memory PGlite (development only). */
export async function openDb(env = process.env): Promise<Db> {
  let db: Db;
  const url = databaseUrl(env);
  if (url) {
    const { default: pg } = await import("pg");
    db = new pg.Pool({ connectionString: url, max: Number(env.PG_POOL_MAX ?? 10), connectionTimeoutMillis: 10_000, idleTimeoutMillis: 10_000 }) as unknown as Db;
  } else {
    if (env.NODE_ENV === "production") throw new Error("DATABASE_URL is required in production");
    const { PGlite } = await import("@electric-sql/pglite");
    db = new PGlite() as unknown as Db;
  }
  await migrate(db);
  return db;
}
