import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app";
import { devAuthenticator } from "../src/auth";
import { aesSecretBox } from "../src/crypto";
import { openDb } from "../src/openDb";
import type { SafeFetch } from "../src/safeFetch";
import { Store } from "../src/store";

export const alice = { authorization: "Bearer dev:alice" };
export const bob = { authorization: "Bearer dev:bob" };
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
const TABLES = "user_sources, user_channels, guide_channels, programmes, watch_events, catalog_streams, catalog_channels";

export async function makeApp(routes: Record<string, unknown> = {}) {
  const db = (shared ??= await openDb({} as NodeJS.ProcessEnv));
  await db.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
  const store = new Store(db);
  const fetcher = fakeFetcher(routes);
  const secrets = aesSecretBox(randomBytes(32));
  const app = buildApp({ store, authenticate: devAuthenticator(), secrets, fetcher, now: () => FIXED });
  return { app, store, db, fetcher, secrets };
}
