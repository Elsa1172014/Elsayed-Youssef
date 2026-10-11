import { describe, expect, it } from "vitest";
import { checkStreamHealth, syncIptvOrg, syncOfficial } from "../src/jobs/catalog";
import { migrate } from "../src/db";
import { alice, bob, makeApp } from "./helpers";

const channels = [
  { id: "A.qa", name: "Al Jazeera", country: "QA", categories: ["news"] },
  { id: "B.us", name: "Kids Club", country: "US", categories: ["kids"] },
];
const feeds = [{ channel: "A.qa", languages: ["ara"] }, { channel: "B.us", languages: ["eng"] }];
const streams = [
  { channel: "A.qa", url: "https://a.example/live.m3u8" },
  { channel: "B.us", url: "https://b.example/live.m3u8" },
];
const API = "https://iptv-org.github.io/api";
const BL = { [`${API}/blocklist.json`]: [], [`${API}/feeds.json`]: feeds };

describe("catalog", () => {
  it("syncs, searches, adds to my channels, and honours takedowns", async () => {
    const { app, store, fetcher } = await makeApp({ ...BL, [`${API}/channels.json`]: channels, [`${API}/streams.json`]: streams });
    expect(await syncIptvOrg(store, fetcher)).toMatchObject({ channels: 2, streams: 2 });
    await syncIptvOrg(store, fetcher); // idempotent
    expect((await app.inject({ url: "/v1/catalog?q=jaz", headers: alice })).json()).toHaveLength(1);
    expect((await app.inject({ url: "/v1/catalog?country=us", headers: alice })).json()[0].id).toBe("B.us");
    expect((await app.inject({ url: "/v1/catalog?category=news", headers: alice })).json()[0].id).toBe("A.qa");
    const byLang = await app.inject({ url: "/v1/catalog?language=ara", headers: alice });
    expect(byLang.json().map((c: { id: string }) => c.id)).toEqual(["A.qa"]);
    expect(byLang.headers["x-total-count"]).toBe("1");
    const facets = (await app.inject({ url: "/v1/catalog/facets", headers: alice })).json();
    expect(facets).toMatchObject({ total: 2, countries: [{ value: "QA", count: 1 }, { value: "US", count: 1 }] });
    expect(facets.languages.map((l: { value: string }) => l.value)).toEqual(["ara", "eng"]);

    const added = await app.inject({ method: "POST", url: "/v1/catalog/A.qa/add", headers: alice });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ name: "Al Jazeera", streamUrl: "https://a.example/live.m3u8", group: "news" });

    await store.setCatalogStatus("B.us", "blocked");
    expect((await app.inject({ url: "/v1/catalog?q=kids", headers: alice })).json()).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/v1/catalog/B.us/add", headers: alice })).statusCode).toBe(404);
  });

  it("loads the curated official list and rejects invalid entries", async () => {
    const { store } = await makeApp();
    const r = await syncOfficial(store, [
      { id: "x", name: "X", provenance: "official", streams: [{ url: "https://x.example/a.m3u8" }] },
      { id: "y", name: "Y", provenance: "paid", streams: [{ url: "https://y.example/a.m3u8" }] },
    ]);
    expect(r).toEqual({ channels: 1 });
    expect((await store.getCatalogChannel("official:x"))?.provenance).toBe("official");
  });

  it("records stream health and prefers healthy streams when adding", async () => {
    const { app, store, fetcher } = await makeApp({
      ...BL,
      [`${API}/channels.json`]: [channels[0]],
      [`${API}/streams.json`]: [{ channel: "A.qa", url: "https://dead.example/a.m3u8" }, { channel: "A.qa", url: "https://ok.example/a.m3u8" }],
      "https://ok.example/a.m3u8": "#EXTM3U\n#EXT-X-VERSION:3\n",
      "https://dead.example/a.m3u8": 404,
    });
    await syncIptvOrg(store, fetcher);
    expect(await checkStreamHealth(store, fetcher)).toEqual({ checked: 2, dead: 1 });
    const added = await app.inject({ method: "POST", url: "/v1/catalog/A.qa/add", headers: alice });
    expect(added.json().streamUrl).toBe("https://ok.example/a.m3u8");
  });
});

describe("migrations", () => {
  it("are idempotent", async () => {
    const { db } = await makeApp();
    expect(await migrate(db)).toEqual([]);
  });
});

describe("full catalog lifecycle", () => {
  const big = Array.from({ length: 1200 }, (_, i) => ({ id: `C${i}.xx`, name: `Channel ${String(i).padStart(4, "0")}`, country: i % 2 ? "EG" : "SA", categories: [i % 3 ? "news" : "sports"] }));
  const bigStreams = big.map((c, i) => ({ channel: c.id, url: `${i % 5 === 0 ? "http" : "https"}://s${i}.example/live.m3u8` }));

  it("syncs a large directory in batches, honors the blocklist, and retires entries that disappear", async () => {
    const routes: Record<string, unknown> = {
      [`${API}/channels.json`]: big, [`${API}/streams.json`]: bigStreams, [`${API}/feeds.json`]: [],
      [`${API}/blocklist.json`]: [{ channel: "C7.xx", reason: "dmca" }],
    };
    const { app, store, fetcher } = await makeApp(routes);
    const r = await syncIptvOrg(store, fetcher);
    expect(r).toMatchObject({ channels: 1199, streams: 1199 });
    expect(await store.countCatalog({})).toBe(1199);
    expect(await store.getCatalogChannel("C7.xx")).toBeUndefined();

    // upstream drops 100 channels -> they are retired; moderator-blocked stay blocked after re-sync
    await store.setCatalogStatus("C1.xx", "blocked");
    routes[`${API}/channels.json`] = big.slice(0, 1100);
    routes[`${API}/streams.json`] = bigStreams.slice(0, 1100);
    const r2 = await syncIptvOrg(store, fetcher);
    expect(r2.pruned).toMatchObject({ closed: 100 });
    expect(await store.countCatalog({})).toBe(1098);
    expect((await store.getCatalogChannel("C1.xx"))?.status).toBe("blocked");

    // an obviously truncated fetch must not wipe the catalog
    routes[`${API}/channels.json`] = big.slice(0, 10);
    routes[`${API}/streams.json`] = bigStreams.slice(0, 10);
    const r3 = await syncIptvOrg(store, fetcher);
    expect(r3.skippedPrune).toMatch(/incomplete/);
    expect(await store.countCatalog({})).toBe(1098);
    void app;
  });

  it("refuses to sync when the blocklist cannot be fetched", async () => {
    const { store, fetcher } = await makeApp({ [`${API}/channels.json`]: big, [`${API}/streams.json`]: bigStreams });
    await expect(syncIptvOrg(store, fetcher)).rejects.toThrow(/blocklist/);
    expect(await store.countCatalog({})).toBe(0);
  });

  it("bulk-imports matching channels with the best stream, skipping duplicates", async () => {
    const { app, store, fetcher } = await makeApp({
      [`${API}/channels.json`]: big, [`${API}/streams.json`]: bigStreams, [`${API}/feeds.json`]: [], [`${API}/blocklist.json`]: [],
    });
    await syncIptvOrg(store, fetcher);
    const imp = await app.inject({ method: "POST", url: "/v1/catalog/import", headers: alice, payload: { country: "eg", category: "news" } });
    expect(imp.statusCode).toBe(201);
    const { added } = imp.json();
    expect(added).toBeGreaterThan(300);
    expect((await app.inject({ method: "POST", url: "/v1/catalog/import", headers: alice, payload: { country: "eg", category: "news" } })).json()).toEqual({ added: 0, skipped: added });
    const mine = (await app.inject({ url: "/v1/me/channels", headers: alice })).json();
    expect(mine).toHaveLength(added);
    expect(mine[0]).toMatchObject({ group: "news" });
    expect((await app.inject({ url: "/v1/me/channels", headers: bob })).json()).toEqual([]);
  });

  it("prefers healthy HTTPS streams when importing", async () => {
    const { app, store, fetcher } = await makeApp({
      [`${API}/channels.json`]: [channels[0]], [`${API}/blocklist.json`]: [], [`${API}/feeds.json`]: [],
      [`${API}/streams.json`]: [{ channel: "A.qa", url: "http://plain.example/a.m3u8" }, { channel: "A.qa", url: "https://secure.example/a.m3u8" }, { channel: "A.qa", url: "https://dead.example/a.m3u8" }],
    });
    await syncIptvOrg(store, fetcher);
    const [dead] = (await store.getCatalogChannel("A.qa"))!.streams.filter((s) => s.url.includes("dead"));
    await store.recordStreamHealth(dead!.id, "dead");
    await app.inject({ method: "POST", url: "/v1/catalog/import", headers: alice, payload: {} });
    expect((await app.inject({ url: "/v1/me/channels", headers: alice })).json()[0].streamUrl).toBe("https://secure.example/a.m3u8");
  });
});

describe("in-app catalog sync", () => {
  const routes = { ...BL, [`${API}/channels.json`]: channels, [`${API}/streams.json`]: streams };

  it("requires a signed-in user, fills an empty catalog, then enforces a cooldown", async () => {
    const { app } = await makeApp(routes);
    expect((await app.inject({ method: "POST", url: "/v1/catalog/sync" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/catalog/sync", headers: alice })).json()).toMatchObject({ running: false, channels: 0, lastSync: null });

    const first = await app.inject({ method: "POST", url: "/v1/catalog/sync", headers: alice });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ channels: 2, streams: 2 });
    const status = (await app.inject({ url: "/v1/catalog/sync", headers: bob })).json();
    expect(status).toMatchObject({ running: false, channels: 2, lastSync: { channels: 2 } });
    expect((await app.inject({ url: "/v1/catalog?q=jaz", headers: bob })).json()).toHaveLength(1);

    const again = await app.inject({ method: "POST", url: "/v1/catalog/sync", headers: bob });
    expect(again.statusCode).toBe(429);
  });

  it("refuses to run twice at once and releases the lock after a failure", async () => {
    const { app, store } = await makeApp({ ...BL, [`${API}/channels.json`]: 500, [`${API}/streams.json`]: streams });
    expect(await store.tryLock("iptv-org-lock", 120)).toBe(true);
    expect((await app.inject({ method: "POST", url: "/v1/catalog/sync", headers: alice })).statusCode).toBe(409);
    expect((await app.inject({ url: "/v1/catalog/sync", headers: alice })).json().running).toBe(true);
    await store.unlock("iptv-org-lock");

    const failed = await app.inject({ method: "POST", url: "/v1/catalog/sync", headers: alice });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toContain("channels.json returned HTTP 500");
    expect(await store.tryLock("iptv-org-lock", 120)).toBe(true); // lock was released
  });

  it("treats a stale lock (crashed function) as free", async () => {
    const { store, db } = await makeApp(routes);
    expect(await store.tryLock("iptv-org-lock", 120)).toBe(true);
    expect(await store.tryLock("iptv-org-lock", 120)).toBe(false);
    await db.query("UPDATE sync_state SET updated_at = now() - interval '5 minutes' WHERE key='iptv-org-lock'");
    expect(await store.tryLock("iptv-org-lock", 120)).toBe(true);
  });
});

describe("body-less requests", () => {
  const json = { "content-type": "application/json" };
  it("accept an empty body with a JSON content type (POST and DELETE) instead of 400 Bad Request", async () => {
    const { app } = await makeApp({ ...BL, [`${API}/channels.json`]: channels, [`${API}/streams.json`]: streams });
    expect((await app.inject({ method: "POST", url: "/v1/catalog/sync", headers: { ...alice, ...json } })).statusCode).toBe(200);
    const added = await app.inject({ method: "POST", url: "/v1/catalog/A.qa/add", headers: { ...alice, ...json } });
    expect(added.statusCode).toBe(201);
    expect((await app.inject({ method: "DELETE", url: `/v1/me/channels/${added.json().id}`, headers: { ...alice, ...json } })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { ...alice, ...json } })).statusCode).toBe(204);
  });
  it("still rejects malformed JSON with 400", async () => {
    const { app } = await makeApp();
    const bad = await app.inject({ method: "POST", url: "/v1/me/channels", headers: { ...alice, ...json }, payload: "{nope" });
    expect(bad.statusCode).toBe(400);
  });
});
