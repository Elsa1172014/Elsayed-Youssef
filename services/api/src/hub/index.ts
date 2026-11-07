import type { Db } from "../db";
import { SportsDbClient, TmdbClient, type Fetch } from "./clients";
import type { Hub } from "./routes";
import { HubStore } from "./store";

export { registerHub, type Hub } from "./routes";
export { runHubCron, syncSports, syncTmdb, DEFAULT_LEAGUES } from "./jobs";
export { HubStore } from "./store";

/**
 * Builds the Entertainment Hub from server env vars. Returns undefined when SUPABASE_DB_URL is not set,
 * so the rest of the platform keeps working unchanged.
 *   SUPABASE_DB_URL     Postgres connection string of the Supabase project (schema "hub")
 *   TMDB_READ_TOKEN     TMDB v4 read access token (or TMDB_API_KEY, v3)
 *   THESPORTSDB_KEY     optional; defaults to the free test key "123"
 *   HUB_ADMIN_USERS     comma-separated usernames allowed into the admin panel
 *   HUB_REGION          "where to watch" region (default AE)
 */
export async function hubFromEnv(env: Record<string, string | undefined> = process.env, opts: { db?: Db; fetch?: Fetch } = {}): Promise<Hub | undefined> {
  let db = opts.db;
  if (!db) {
    const url = env.SUPABASE_DB_URL;
    if (!url) return undefined;
    const { default: pg } = await import("pg");
    db = new pg.Pool({ connectionString: url, max: Number(env.HUB_POOL_MAX ?? 2), connectionTimeoutMillis: 10_000, idleTimeoutMillis: 10_000, ssl: /sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: false } }) as unknown as Db;
  }
  const tmdbKey = env.TMDB_READ_TOKEN || env.TMDB_API_KEY;
  const sportsKey = env.THESPORTSDB_KEY || "123";
  return {
    store: new HubStore(db),
    clients: { tmdb: tmdbKey ? new TmdbClient(tmdbKey, opts.fetch) : undefined, sports: new SportsDbClient(sportsKey, opts.fetch), region: (env.HUB_REGION || "AE").toUpperCase().slice(0, 2) },
    admins: (env.HUB_ADMIN_USERS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
    keys: { tmdb: !!tmdbKey, sportsdbOwnKey: !!env.THESPORTSDB_KEY && sportsKey !== "123" && sportsKey !== "3", supabase: true },
  };
}
