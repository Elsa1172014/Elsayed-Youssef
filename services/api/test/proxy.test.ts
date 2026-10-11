import { describe, expect, it } from "vitest";
import { rewriteManifest } from "../src/hlsProxy";
import type { SafeOpen } from "../src/safeFetch";
import { alice, makeApp } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);
const body = (s: string | Uint8Array) => new Response(s).body;

function fakeOpen(routes: Record<string, { status?: number; type?: string; body?: string; throws?: string }>): SafeOpen & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return { status: 404, headers: new Headers(), body: null, url };
    if (r.throws) throw Object.assign(new Error(r.throws), { name: r.throws });
    return { status: r.status ?? 200, headers: new Headers({ "content-type": r.type ?? "application/octet-stream" }), body: body(r.body ?? ""), url };
  }) as SafeOpen & { calls: string[] };
  f.calls = calls;
  return f;
}

const MASTER = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/index.m3u8\n";
const MEDIA = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\nhttp://cdn.example/seg2.ts\n';
const routes = {
  "http://old.example/live/master.m3u8": { type: "application/vnd.apple.mpegurl", body: MASTER },
  "http://old.example/live/low/index.m3u8": { type: "application/x-mpegURL", body: MEDIA },
  "http://old.example/live/low/seg1.ts": { type: "video/mp2t", body: "SEGMENT-ONE" },
  "http://old.example/live/low/key.bin": { body: "KEY" },
  "http://dead.example/x.m3u8": { status: 403 },
  "http://gone.example/x.m3u8": { status: 404 },
  "http://slow.example/x.m3u8": { throws: "AbortError" },
  "http://down.example/x.m3u8": { throws: "fetch failed" },
  "http://html.example/x.m3u8": { type: "text/html", body: "<html>nope</html>" },
};

async function proxyUrlFor(app: Awaited<ReturnType<typeof makeApp>>["app"], url: string) {
  const ch = (await app.inject({ method: "POST", url: "/v1/me/channels", headers: alice, payload: { name: "T", streamUrl: url } })).json();
  const r = (await app.inject({ url: `/v1/me/channels/${ch.id}/stream`, headers: alice })).json();
  return r as { url: string; proxy: string };
}

describe("HLS relay", () => {
  it("rewrites manifests and relays segments and keys, without needing a session", async () => {
    const opener = fakeOpen(routes);
    const { app } = await makeApp({}, { opener });
    const s = await proxyUrlFor(app, "http://old.example/live/master.m3u8");
    expect(s.url).toBe("http://old.example/live/master.m3u8");
    const master = await app.inject({ url: s.proxy }); // no Authorization header: browsers' players follow plain URLs
    expect(master.statusCode).toBe(200);
    expect(master.headers["content-type"]).toContain("mpegurl");
    expect(master.body).not.toContain("old.example");
    const variant = master.body.split("\n").find((l) => l.startsWith("/v1/proxy"))!;
    const media = (await app.inject({ url: variant })).body;
    const lines = media.split("\n");
    const keyLine = lines.find((l) => l.startsWith("#EXT-X-KEY"))!;
    expect(keyLine).toMatch(/URI="\/v1\/proxy\?u=/);
    const segs = lines.filter((l) => l.startsWith("/v1/proxy"));
    expect(segs).toHaveLength(2);
    const seg = await app.inject({ url: segs[0]! });
    expect(seg.statusCode).toBe(200);
    expect(seg.headers["content-type"]).toBe("video/mp2t");
    expect(seg.body).toBe("SEGMENT-ONE");
    await app.inject({ url: segs[1]! });
    expect(opener.calls).toContain("http://cdn.example/seg2.ts");
    const key = keyLine.match(/URI="([^"]+)"/)![1]!;
    expect((await app.inject({ url: key })).body).toBe("KEY");
  });

  it("is not an open proxy: tampered, unsigned and expired links are refused", async () => {
    const opener = fakeOpen(routes);
    const { app, clock } = await makeApp({}, { opener });
    const s = await proxyUrlFor(app, "http://old.example/live/master.m3u8");
    const u = new URL(s.proxy, "http://x");
    const other = Buffer.from("http://old.example/live/low/key.bin").toString("base64url");
    expect((await app.inject({ url: `/v1/proxy?u=${other}&e=${u.searchParams.get("e")}&s=${u.searchParams.get("s")}` })).statusCode).toBe(403);
    expect((await app.inject({ url: "/v1/proxy?u=" + other })).statusCode).toBe(403);
    expect((await app.inject({ url: "/v1/proxy" })).statusCode).toBe(403);
    clock.now = new Date(clock.now.getTime() + 7 * 3600_000);
    expect((await app.inject({ url: s.proxy })).statusCode).toBe(403);
    expect(opener.calls).toHaveLength(0);
  });

  it("explains dead, missing, slow, offline and non-HLS streams", async () => {
    const opener = fakeOpen(routes);
    const { app } = await makeApp({}, { opener });
    const msg = async (url: string) => {
      const r = await app.inject({ url: (await proxyUrlFor(app, url)).proxy });
      return [r.statusCode, r.json().error as string] as const;
    };
    expect(await msg("http://dead.example/x.m3u8")).toEqual([502, expect.stringContaining("refused")]);
    expect(await msg("http://gone.example/x.m3u8")).toEqual([502, expect.stringContaining("no longer available")]);
    expect(await msg("http://slow.example/x.m3u8")).toEqual([504, expect.stringContaining("in time")]);
    expect(await msg("http://down.example/x.m3u8")).toEqual([502, expect.stringContaining("offline")]);
    expect(await msg("http://html.example/x.m3u8")).toEqual([502, expect.stringContaining("not return a valid playlist")]);
  });

  it("rewriteManifest resolves relative, root-relative and absolute references", () => {
    const out = rewriteManifest("#EXTM3U\na.ts\n/b.ts\nhttps://c.example/c.ts\nftp://x/y\n", "http://h.example/p/m.m3u8", (u) => `S(${u})`);
    expect(out).toBe("#EXTM3U\nS(http://h.example/p/a.ts)\nS(http://h.example/b.ts)\nS(https://c.example/c.ts)\nftp://x/y\n");
  });
});

describe("bulk add", () => {
  it("adds ~10k catalog channels in one request, fast, and skips duplicates on the second run", async () => {
    const { app, db } = await makeApp();
    await db.query(`INSERT INTO catalog_channels (id,name,country,languages,categories,provenance) SELECT 'c'||g, 'Channel '||lpad(g::text,5,'0'), 'EG', '["ara"]'::jsonb, '["news"]'::jsonb, 'fta' FROM generate_series(1,10000) g`);
    await db.query(`INSERT INTO catalog_streams (channel_id,url,status) SELECT 'c'||g, 'http://s.example/'||g||'.m3u8', 'unknown' FROM generate_series(1,10000) g`);
    await db.query(`INSERT INTO catalog_streams (channel_id,url,status) SELECT 'c'||g, 'https://s.example/'||g||'.m3u8', 'unknown' FROM generate_series(1,10000,2) g`);
    const t = Date.now();
    const r = await app.inject({ method: "POST", url: "/v1/catalog/import", headers: alice, payload: { limit: 20000 } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ added: 10000, skipped: 0 });
    expect(Date.now() - t).toBeLessThan(15_000);
    const mine = (await app.inject({ url: "/v1/me/channels", headers: alice })).json();
    expect(mine).toHaveLength(10000);
    expect(mine[0].name).toBe("Channel 00001");
    expect(mine[0].streamUrl).toBe("https://s.example/1.m3u8"); // HTTPS preferred
    expect(mine[0]).toMatchObject({ country: "EG", languages: ["ara"], categories: ["news"], group: "news" }); // kept for grouping in the Live tab
    expect(mine[1].streamUrl).toBe("http://s.example/2.m3u8");
    expect((await app.inject({ method: "POST", url: "/v1/catalog/import", headers: alice, payload: { limit: 20000 } })).json()).toEqual({ added: 0, skipped: 10000 });
  });
});

describe("Arabic filter", () => {
  it("matches Arabic-language or Arab-country channels and imports them in one go", async () => {
    const { app, db } = await makeApp();
    await db.query(`INSERT INTO catalog_channels (id,name,country,languages,provenance) VALUES
      ('a','Nile TV','EG','[]','fta'),('b','Spanish Show','US','["ara"]','fta'),('c','English News','GB','["eng"]','fta'),('d','Kuwait Live','KW','[]','fta')`);
    await db.query(`INSERT INTO catalog_streams (channel_id,url) SELECT id, 'https://x.example/'||id||'.m3u8' FROM catalog_channels`);
    const list = (await app.inject({ url: "/v1/catalog?arabic=1", headers: alice })).json();
    expect(list.map((c: { id: string }) => c.id).sort()).toEqual(["a", "b", "d"]);
    const r = await app.inject({ method: "POST", url: "/v1/catalog/import", headers: alice, payload: { arabic: "1" } });
    expect(r.json()).toEqual({ added: 3, skipped: 0 });
  });
});

describe("Europe filter", () => {
  it("matches European countries only", async () => {
    const { app, db } = await makeApp();
    await db.query(`INSERT INTO catalog_channels (id,name,country,provenance) VALUES ('a','France 24','FR','fta'),('b','BBC','GB','fta'),('c','Nile TV','EG','fta'),('d','CNN','US','fta')`);
    await db.query(`INSERT INTO catalog_streams (channel_id,url) SELECT id, 'https://x.example/'||id||'.m3u8' FROM catalog_channels`);
    const list = (await app.inject({ url: "/v1/catalog?europe=1", headers: alice })).json();
    expect(list.map((c: { id: string }) => c.id).sort()).toEqual(["a", "b"]);
  });
});

describe("persistence", () => {
  it("keeps channels, sources and settings across sign-out, sign-in and a fresh server instance", async () => {
    const M3U = "#EXTM3U\n" + Array.from({ length: 1200 }, (_, i) => `#EXTINF:-1 group-title="News",Chan ${i}\nhttps://p.example/${i}.m3u8`).join("\n");
    const { app, db, auth, secrets, fetcher } = await makeApp({ "https://lists.example/my.m3u": M3U });
    const { buildApp } = await import("../src/app");
    const { tokenAuthenticator } = await import("../src/auth");
    const { Store } = await import("../src/store");

    await app.inject({ method: "POST", url: "/v1/me/channels", headers: alice, payload: { name: "Mine", streamUrl: "https://mine.example/a.m3u8" } });
    const src = (await app.inject({ method: "POST", url: "/v1/me/sources", headers: alice, payload: { name: "List", type: "m3u_url", url: "https://lists.example/my.m3u", ownershipAttested: true } })).json();
    const sync = await app.inject({ method: "POST", url: `/v1/me/sources/${src.id}/sync`, headers: alice });
    expect(sync.json()).toEqual({ added: 1200 });

    // sign out (revokes the session only), then sign in again with the same credentials
    expect((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: alice })).statusCode).toBeLessThan(300);
    expect((await app.inject({ url: "/v1/me/channels", headers: alice })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { username: "alice", password: "correct horse battery" } });
    const again = { authorization: `Bearer ${login.json().token}` };

    // a brand-new server instance on the same database (cold start / redeploy) sees everything
    const app2 = buildApp({ store: new Store(db), auth, authenticate: tokenAuthenticator(auth), secrets, fetcher });
    for (const a of [app, app2]) {
      const all = (await a.inject({ url: "/v1/me/channels", headers: again })).json();
      expect(all).toHaveLength(1201);
      const page = await a.inject({ url: "/v1/me/channels?limit=500&offset=1000", headers: again });
      expect(page.json()).toHaveLength(201);
      expect(page.headers["x-total-count"]).toBe("1201");
      expect((await a.inject({ url: "/v1/me/sources", headers: again })).json()).toHaveLength(1);
    }
  });
});
