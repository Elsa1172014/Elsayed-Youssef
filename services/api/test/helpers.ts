import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app";
import { AuthService, tokenAuthenticator } from "../src/auth";
import { aesSecretBox } from "../src/crypto";
import { openDb } from "../src/openDb";
import type { SafeFetch } from "../src/safeFetch";
import { Store } from "../src/store";

/** Auth headers for two registered test users; refreshed by every makeApp() call. */
export const alice: Record<string, string> = { authorization: "" };
export const bob: Record<string, string> = { authorization: "" };
export const PASSWORD = "correct horse battery";
export const FIXED = new Date("2026-10-11T18:30:00Z");

/** Fake provider network: url -> body (string/object) or status code. */
export function fakeFetcher(routes: Record<string, unknown>): SafeFetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const hit = routes[url] ?? routes[url.split("?")[0]! + "?*"];
    if (hit === undefined) return { ok: false, status: 404, text: async () => "" };
    if (typeof hit === "number") return { ok: false, status: hit, text: async () => "" };
    return { ok: true, status: 200, text: async () => (typeof hit === "string" ? hit : JSON.stringify(hit)) };
  }) as SafeFetch & { calls: string[] };
  f.calls = calls;
  return f;
}

// PGlite takes ~3s to boot, so each test file boots it once and truncates between tests.
let shared: Awaited<ReturnType<typeof openDb>> | undefined;
const TABLES = "users, sessions, user_sources, user_channels, guide_channels, programmes, watch_events, catalog_streams, catalog_channels, sync_state";

export async function makeApp(routes: Record<string, unknown> = {}, opts: { allowedOrigins?: string[] } = {}) {
  const db = (shared ??= await openDb({} as NodeJS.ProcessEnv));
  await db.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
  const store = new Store(db);
  const fetcher = fakeFetcher(routes);
  const secrets = aesSecretBox(randomBytes(32));
  const clock = { now: FIXED };
  const auth = new AuthService(db, () => clock.now);
  const app = buildApp({ store, auth, authenticate: tokenAuthenticator(auth), secrets, fetcher, now: () => clock.now, allowedOrigins: opts.allowedOrigins });
  alice.authorization = `Bearer ${(await auth.register("alice", PASSWORD)).token}`;
  bob.authorization = `Bearer ${(await auth.register("bob", PASSWORD)).token}`;
  return { app, store, db, fetcher, secrets, auth, clock };
}
