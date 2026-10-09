import { Client } from "pg";

export const DB_URL = () => process.env.TEST_DB_URL!;

export async function connect(): Promise<Client> {
  const c = new Client({ connectionString: DB_URL() });
  await c.connect();
  return c;
}

export type Actor = { sub: string | null; role: "authenticated" | "anon" | "service_role" };

/** Runs `fn` inside a transaction as the given actor (mimicking PostgREST's JWT claim GUCs); always rolls back. */
export async function as<T>(db: Client, actor: Actor, fn: (q: Client["query"]) => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    await db.query(`set local role ${actor.role}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)", [
      actor.sub ?? "",
      actor.role,
    ]);
    return await fn(db.query.bind(db) as Client["query"]);
  } finally {
    await db.query("rollback");
  }
}

/** Like `as`, but commits (for multi-step scenarios that need persisted state). */
export async function asCommit<T>(db: Client, actor: Actor, fn: (q: Client["query"]) => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    await db.query(`set local role ${actor.role}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)", [
      actor.sub ?? "",
      actor.role,
    ]);
    const r = await fn(db.query.bind(db) as Client["query"]);
    await db.query("commit");
    return r;
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
}

export const authed = (sub: string): Actor => ({ sub, role: "authenticated" });
export const service: Actor = { sub: null, role: "service_role" };
export const anon: Actor = { sub: null, role: "anon" };

export function vec(i: number, dims = 1536): string {
  const a = new Array(dims).fill(0);
  a[i] = 1;
  return `[${a.join(",")}]`;
}
