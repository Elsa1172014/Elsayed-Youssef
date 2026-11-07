import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import { hubFromEnv, runHubCron } from "../src/hub";
import { alice, bob, makeApp } from "./helpers";

const SQL = readFileSync(new URL("../hub/supabase_hub.sql", import.meta.url), "utf8");

/** Fake TMDB + TheSportsDB (no network). Records request URLs/headers to check key handling. */
function fakeApis(opts: { tmdbFails?: boolean } = {}) {
  const calls: { url: string; auth?: string }[] = [];
  const f = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("api.themoviedb.org")) {
      if (opts.tmdbFails) return json({ status_message: "Invalid API key" }, 401);
      if (url.includes("/genre/")) return json({ genres: [{ id: 28, name: "أكشن" }, { id: 18, name: "دراما" }] });
      if (url.includes("/trending/all/week")) return json({ results: url.includes("page=1") ? [
        { id: 11, media_type: "movie", title: "فيلم أ", overview: "قصة", poster_path: "/a.jpg", release_date: "2026-05-01", vote_average: 7.84, genre_ids: [28] },
        { id: 22, media_type: "tv", name: "مسلسل ب", first_air_date: "2025-01-02", vote_average: 8.1, genre_ids: [18] },
        { id: 33, media_type: "person", name: "Someone" },
      ] : [] });
      if (url.includes("/watch/providers")) return json({ results: { AE: { link: "https://www.themoviedb.org/movie/11/watch?locale=AE", flatrate: [{ provider_name: "Netflix", logo_path: "/n.png" }] } } });
      if (url.includes("/search/multi")) return json({ results: [{ id: 44, media_type: "movie", title: "بحث" }] });
      if (url.includes("/movie/44")) return json({ id: 44, title: "بحث", genres: [{ id: 28, name: "أكشن" }] });
      return json({}, 404);
    }
    if (url.includes("thesportsdb.com")) {
      if (url.includes("lookupleague.php")) {
        const id = new URL(url).searchParams.get("id");
        return json({ leagues: [{ idLeague: id, strLeague: `League ${id}`, strSport: "Soccer" }] });
      }
      if (url.includes("eventsnextleague.php")) return json({ events: [{ idEvent: "e1", idLeague: "4328", strLeague: "League 4328", strHomeTeam: "Home", strAwayTeam: "Away", strTimestamp: "2099-01-01T18:00:00", strVenue: "Stadium" }] });
      if (url.includes("eventspastleague.php")) return json({ events: [{ idEvent: "e0", idLeague: "4328", strHomeTeam: "A", strAwayTeam: "B", dateEvent: new Date(Date.now() - 86400_000).toISOString().slice(0, 10), strTime: "20:00:00", intHomeScore: "2", intAwayScore: "1" }] });
      return json({ events: null });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { f, calls };
}

async function hubDb(): Promise<Db> {
  const db = new PGlite();
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated;"); // Supabase's API roles, so the real migration runs unchanged
  await db.exec(SQL);
  return db as unknown as Db;
}

describe("Entertainment Hub", () => {
  let db: Db;
  beforeEach(async () => { db = await hubDb(); });

  it("keeps Supabase's public API roles out of every hub table (RLS on, no grants)", async () => {
    const r = await db.query<{ relname: string; rls: boolean; anon: boolean }>(
      "SELECT c.relname, c.relrowsecurity AS rls, has_table_privilege('anon', c.oid, 'select') AS anon FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hub' AND c.relkind='r' ORDER BY 1",
    );
    expect(r.rows).toHaveLength(6);
    for (const t of r.rows) expect(t).toMatchObject({ rls: true, anon: false });
  });

  it("is off (and the rest of the platform unaffected) without SUPABASE_DB_URL", async () => {
    expect(await hubFromEnv({})).toBeUndefined();
    const { app } = await makeApp();
    expect((await app.inject({ url: "/v1/hub/status", headers: alice })).json()).toMatchObject({ enabled: false });
    expect((await app.inject({ url: "/v1/hub/titles", headers: alice })).statusCode).toBe(503);
    expect((await app.inject({ url: "/v1/me/channels", headers: alice })).statusCode).toBe(200);
  });

  it("syncs TMDB trending + JustWatch providers and TheSportsDB fixtures via the cron, logging runs", async () => {
    const { f, calls } = fakeApis();
    const hub = (await hubFromEnv({ TMDB_READ_TOKEN: "x".repeat(60), HUB_ADMIN_USERS: "alice" }, { db, fetch: f }))!;
    const r = await runHubCron(hub.store, hub.clients);
    expect(r.tmdb).toMatchObject({ ok: true, saved: 2, providers: 2 });
    expect(r.sports).toMatchObject({ ok: true, leagues: 4, freeKey: true });
    // Bearer token in a header, never in the URL; free SportsDB key by default.
    expect(calls.filter((c) => c.url.includes("themoviedb")).every((c) => c.auth?.startsWith("Bearer ") && !c.url.includes("api_key"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/json/123/"))).toBe(true);

    const { app } = await makeApp({}, { hub });
    const titles = (await app.inject({ url: "/v1/hub/titles", headers: bob })).json();
    expect(titles.total).toBe(2);
    expect(titles.items[0]).toMatchObject({ title: "فيلم أ", genres: ["أكشن"], voteAverage: 7.8, providers: { flatrate: [{ name: "Netflix" }] } });
    expect((await app.inject({ url: "/v1/hub/titles?kind=tv", headers: bob })).json().items[0].title).toBe("مسلسل ب");
    const upcoming = (await app.inject({ url: "/v1/hub/matches", headers: bob })).json();
    expect(upcoming[0]).toMatchObject({ homeTeam: "Home", awayTeam: "Away", eventTime: "2099-01-01T18:00:00.000Z" });
    expect((await app.inject({ url: "/v1/hub/matches?range=recent", headers: bob })).json()[0]).toMatchObject({ homeScore: 2, awayScore: 1 });
    expect(hub.store.jobs).toBeDefined();
    expect((await hub.store.jobs()).map((j) => j.job).sort()).toEqual(["sports", "tmdb"]);
  });

  it("records provider failures in the error log without exposing keys", async () => {
    const { f } = fakeApis({ tmdbFails: true });
    const hub = (await hubFromEnv({ TMDB_API_KEY: "secretv3key0000000000000000000000" }, { db, fetch: f }))!;
    const r = await runHubCron(hub.store, hub.clients);
    expect(r.tmdb.ok).toBe(false);
    const errors = await hub.store.errors();
    expect(errors.some((e) => e.source === "tmdb")).toBe(true);
    expect(JSON.stringify(errors)).not.toContain("secretv3key");
    const noKey = (await hubFromEnv({}, { db, fetch: f }))!;
    expect((await runHubCron(noKey.store, noKey.clients)).tmdb).toMatchObject({ ok: false, error: expect.stringContaining("not configured") });
  });

  it("restricts the admin panel to HUB_ADMIN_USERS and validates licensed sources", async () => {
    const { f } = fakeApis();
    const hub = (await hubFromEnv({ TMDB_READ_TOKEN: "x".repeat(60), HUB_ADMIN_USERS: "Alice" }, { db, fetch: f }))!;
    const { app } = await makeApp({}, { hub });
    expect((await app.inject({ url: "/v1/hub/status", headers: alice })).json()).toMatchObject({ enabled: true, isAdmin: true, keys: { tmdb: true, sportsdbOwnKey: false } });
    expect((await app.inject({ url: "/v1/hub/status", headers: bob })).json().isAdmin).toBe(false);
    expect((await app.inject({ url: "/v1/hub/admin/overview", headers: bob })).statusCode).toBe(403);
    expect(JSON.stringify((await app.inject({ url: "/v1/hub/status", headers: alice })).json())).not.toContain("xxxxxxxx");

    const t = (await app.inject({ method: "POST", url: "/v1/hub/admin/titles", headers: alice, payload: { kind: "movie", tmdbId: 44 } })).json();
    expect(t).toMatchObject({ title: "بحث", featured: true });
    const src = (p: Record<string, unknown>) => app.inject({ method: "POST", url: `/v1/hub/admin/titles/${t.id}/sources`, headers: alice, payload: { label: "Trailer", url: "https://cdn.example.org/a/master.m3u8", rightsHolder: "Studio", licenseRef: "Contract 12", rightsAttested: true, ...p } });
    expect((await src({ rightsAttested: false })).statusCode).toBe(400);
    expect((await src({ url: "http://cdn.example.org/a.m3u8" })).statusCode).toBe(400);
    expect((await src({ drmSystem: "widevine" })).statusCode).toBe(400); // DRM without the rights holder's license server
    expect((await src({ drmSystem: "widevine", licenseUrl: "https://license.example.org/wv" })).statusCode).toBe(201);
    expect((await src({ validUntil: "2000-01-01" })).statusCode).toBe(201); // expired licence: stored, never shown to viewers
    const view = (await app.inject({ url: `/v1/hub/titles/${t.id}`, headers: bob })).json();
    expect(view.sources).toHaveLength(1);
    expect(view.sources[0]).toEqual({ id: expect.any(Number), label: "Trailer", url: "https://cdn.example.org/a/master.m3u8", kind: "hls", drmSystem: "widevine", licenseUrl: "https://license.example.org/wv" });
    expect((await app.inject({ url: `/v1/hub/admin/titles/${t.id}/sources`, headers: bob })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/hub/admin/leagues", headers: alice, payload: { id: "4387" } })).json()).toMatchObject({ id: "4387", name: "League 4387" });
    expect((await app.inject({ method: "POST", url: "/v1/hub/admin/leagues", headers: alice, payload: { id: "x;drop" } })).statusCode).toBe(400);
  });
});

describe("receiver library (tuner source)", () => {
  it("imports an HDHomeRun lineup and an OpenWebif box through their official APIs", async () => {
    const { app } = await makeApp({
      "https://tuner.example.org/lineup.json": [{ GuideNumber: "2.1", GuideName: "FTA One", URL: "https://tuner.example.org/auto/v2.1" }, { GuideNumber: "9.1", GuideName: "Protected", URL: "https://tuner.example.org/auto/v9.1", DRM: 1 }],
      "https://box.example.org/api/getallservices": { services: [{ servicename: "Bouquet", subservices: [{ servicename: "Box Channel", servicereference: "1:0:1:2:3:4:5:0:0:0:" }] }] },
    });
    const add = async (url: string) => (await app.inject({ method: "POST", url: "/v1/me/sources", headers: alice, payload: { name: "Receiver", type: "tuner", url, ownershipAttested: true } })).json();
    const hd = await add("https://tuner.example.org/lineup.json");
    expect((await app.inject({ method: "POST", url: `/v1/me/sources/${hd.id}/sync`, headers: alice })).json()).toMatchObject({ added: 1 });
    const box = await add("https://box.example.org");
    expect((await app.inject({ method: "POST", url: `/v1/me/sources/${box.id}/sync`, headers: alice })).json()).toMatchObject({ added: 1 });
    const names = (await app.inject({ url: "/v1/me/channels", headers: alice })).json().map((c: { name: string; streamUrl: string }) => `${c.name}|${c.streamUrl}`);
    expect(names).toEqual(expect.arrayContaining(["FTA One|https://tuner.example.org/auto/v2.1", "Box Channel|https://box.example.org:8001/1:0:1:2:3:4:5:0:0:0:"]));
    expect(names.some((n: string) => n.startsWith("Protected"))).toBe(false);
  });
});
