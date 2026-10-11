import { describe, expect, it } from "vitest";
import type { SafeOpen } from "../src/safeFetch";
import { alice, bob, makeApp } from "./helpers";

type Route = { status?: number; type?: string; body?: string | Uint8Array; throws?: string };
function fakeOpen(routes: Record<string, Route>): SafeOpen & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return { status: 404, headers: new Headers(), body: null, url };
    if (r.throws) throw Object.assign(new Error(r.throws), { name: r.throws });
    return { status: r.status ?? 200, headers: new Headers({ "content-type": r.type ?? "application/octet-stream" }), body: new Response(r.body ?? "").body, url };
  }) as SafeOpen & { calls: string[] };
  f.calls = calls;
  return f;
}
const TS = new Uint8Array(400); TS[0] = 0x47; TS[188] = 0x47;
const HLS = "application/vnd.apple.mpegurl";
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.4d401f,mp4a.40.2"\nlow.m3u8\n';
const MEDIA = "#EXTM3U\n#EXTINF:4,\ns1.ts\n";
const GOOD = {
  "https://good.example/m.m3u8": { type: HLS, body: MASTER },
  "https://good.example/low.m3u8": { type: HLS, body: MEDIA },
  "https://good.example/s1.ts": { type: "video/mp2t", body: TS },
};

async function addChannel(app: Awaited<ReturnType<typeof makeApp>>["app"], name: string, streamUrl: string, extra: Record<string, unknown> = {}) {
  return (await app.inject({ method: "POST", url: "/v1/me/channels", headers: alice, payload: { name, streamUrl, ...extra } })).json() as { id: string };
}
const diagnose = async (app: Awaited<ReturnType<typeof makeApp>>["app"], id: string) => (await app.inject({ method: "POST", url: `/v1/me/channels/${id}/diagnose`, headers: alice })).json();

describe("POST /v1/me/channels/:id/diagnose", () => {
  it("follows master -> variant -> segment and verifies real media bytes", async () => {
    const open = fakeOpen(GOOD);
    const { app } = await makeApp({}, { opener: open });
    const ch = await addChannel(app, "Good", "https://good.example/m.m3u8");
    const d = await diagnose(app, ch.id);
    expect(d).toMatchObject({ ok: true, kind: "hls", cause: "none", codecs: ["avc1.4d401f", "mp4a.40.2"] });
    expect(d.steps.map((s: { id: string }) => s.id)).toEqual(["url", "server", "type", "manifest", "protection", "media"]);
    expect(open.calls).toEqual(["https://good.example/m.m3u8", "https://good.example/low.m3u8", "https://good.example/s1.ts"]);
    expect(d.proxy).toMatch(/^\/v1\/proxy\?/);
  });

  it("does not call a stream working just because the playlist answers 200", async () => {
    const { app } = await makeApp({}, { opener: fakeOpen({
      "https://fake.example/m.m3u8": { type: HLS, body: MEDIA },
      "https://fake.example/s1.ts": { type: "video/mp2t", body: "<html>blocked</html>" },
    }) });
    const d = await diagnose(app, (await addChannel(app, "Fake", "https://fake.example/m.m3u8")).id);
    expect(d).toMatchObject({ ok: false, cause: "no_media_data" });
    expect(d.steps.at(-1)).toMatchObject({ id: "media", ok: false });
  });

  it("reports the real cause for refused, missing, slow, unreachable and non-stream URLs", async () => {
    const { app } = await makeApp({}, { opener: fakeOpen({
      "https://a.example/x.m3u8": { status: 401 }, "https://b.example/x.m3u8": { status: 403 }, "https://c.example/x.m3u8": { status: 404 },
      "https://d.example/x.m3u8": { throws: "AbortError" }, "https://e.example/x.m3u8": { throws: "fetch failed" },
      "https://f.example/x.m3u8": { type: "text/html", body: "<html>hi</html>" }, "https://g.example/x.m3u8": { status: 503 },
    }) });
    const causes: Record<string, string> = { a: "auth_required", b: "forbidden", c: "gone", d: "timeout", e: "network", f: "not_media", g: "server_error" };
    for (const [h, cause] of Object.entries(causes)) {
      const d = await diagnose(app, (await addChannel(app, h, `https://${h}.example/x.m3u8`)).id);
      expect([h, d.cause]).toEqual([h, cause]);
      expect(d.ok).toBe(false);
    }
  });

  it("detects DRM from the manifest and does not try to read protected media", async () => {
    const open = fakeOpen({ "https://drm.example/m.mpd": { type: "application/dash+xml", body: '<MPD><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/></MPD>' } });
    const { app } = await makeApp({}, { opener: open });
    const d = await diagnose(app, (await addChannel(app, "Paid", "https://drm.example/m.mpd")).id);
    expect(d).toMatchObject({ ok: false, kind: "dash", cause: "drm_protected" });
    expect(d.protection.drm).toEqual(["widevine"]);
    expect(open.calls).toHaveLength(1);
  });

  it("rejects private addresses and other users' channels", async () => {
    const open = fakeOpen({});
    const { app } = await makeApp({}, { opener: open });
    const ch = await addChannel(app, "Mine", "https://good.example/m.m3u8");
    expect((await app.inject({ method: "POST", url: `/v1/me/channels/${ch.id}/diagnose`, headers: bob })).statusCode).toBe(404);
    const priv = await app.inject({ method: "POST", url: "/v1/me/channels", headers: alice, payload: { name: "P", streamUrl: "http://10.0.0.1/x.m3u8" } });
    if (priv.statusCode === 201) {
      const d = await diagnose(app, priv.json().id);
      expect(d.cause).toBe("invalid_url");
    }
    expect(open.calls.some((c) => c.includes("10.0.0.1"))).toBe(false);
  });
});

describe("POST /v1/me/channels/:id/find-source", () => {
  const find = async (app: Awaited<ReturnType<typeof makeApp>>["app"], id: string) => (await app.inject({ method: "POST", url: `/v1/me/channels/${id}/find-source`, headers: alice })).json() as { tried: number; candidates: { name: string; url: string; origin: string }[] };

  it("tests the same channel's other registered sources and returns only those that really serve media", async () => {
    const { app } = await makeApp({}, { opener: fakeOpen({
      ...GOOD,
      "https://dead.example/m.m3u8": { status: 404 },
      "https://other.example/m.m3u8": { type: HLS, body: MEDIA },
      "https://other.example/s1.ts": { status: 403 },
    }) });
    const main = await addChannel(app, "beIN SPORTS 1", "https://dead.example/m.m3u8");
    await addChannel(app, "beIN SPORTS 1 HD", "https://good.example/m.m3u8");
    await addChannel(app, "beIN SPORTS 1", "https://other.example/m.m3u8");
    await addChannel(app, "beIN SPORTS 2", "https://good.example/m.m3u8?other=1"); // a different channel: never picked
    const r = await find(app, main.id);
    expect(r.tried).toBe(2);
    expect(r.candidates.map((c) => [c.name, c.url, c.origin])).toEqual([["beIN SPORTS 1 HD", "https://good.example/m.m3u8", "registered"]]);
  });

  it("finds the channel's other listed catalog streams by strict match and skips similar names", async () => {
    const { app, store } = await makeApp({}, { opener: fakeOpen({ ...GOOD, "https://old.example/x.m3u8": { status: 404 } }) });
    await store.upsertCatalog([
      { id: "News1.qa", name: "News One", country: "QA", languages: ["ara"], categories: ["news"], provenance: "directory", streams: [{ url: "https://old.example/x.m3u8" }, { url: "https://good.example/m.m3u8" }] },
      { id: "News1Plus.qa", name: "News One Plus", country: "QA", languages: ["ara"], categories: ["news"], provenance: "directory", streams: [{ url: "https://good.example/plus.m3u8" }] },
      { id: "News1.de", name: "News One", country: "DE", languages: ["deu"], categories: ["news"], provenance: "directory", streams: [{ url: "https://good.example/de.m3u8" }] },
    ]);
    const main = await addChannel(app, "News One", "https://old.example/x.m3u8", { country: "QA" });
    const r = await find(app, main.id);
    expect(r.candidates.map((c) => [c.url, c.origin])).toEqual([["https://good.example/m.m3u8", "catalog"]]);
  });

  it("renews an expired link from the user's own playlist source", async () => {
    const list = (token: string) => `#EXTM3U\n#EXTINF:-1 tvg-id="aj.qa",Al Jazeera\nhttps://good.example/m.m3u8?token=${token}\n`;
    const routes: Record<string, unknown> = { "https://provider.example/list.m3u": list("old") };
    const { app } = await makeApp(routes, { opener: fakeOpen({
      ...GOOD, "https://good.example/m.m3u8?token=fresh": { type: HLS, body: MEDIA }, "https://good.example/m.m3u8?token=old": { status: 403 },
    }) });
    const src = (await app.inject({ method: "POST", url: "/v1/me/sources", headers: alice, payload: { name: "Mine", type: "m3u_url", url: "https://provider.example/list.m3u", ownershipAttested: true } })).json();
    expect((await app.inject({ method: "POST", url: `/v1/me/sources/${src.id}/sync`, headers: alice })).json()).toEqual({ added: 1 });
    const ch = (await app.inject({ url: "/v1/me/channels", headers: alice })).json()[0] as { id: string };
    expect((await diagnose(app, ch.id)).cause).toBe("forbidden");
    routes["https://provider.example/list.m3u"] = list("fresh"); // the provider re-issued the link
    const r = await find(app, ch.id);
    expect(r.candidates.map((c) => [c.url, c.origin])).toEqual([["https://good.example/m.m3u8?token=fresh", "renewed"]]);
  });

  it("asks for a new login when the user's own Xtream account is rejected, instead of probing blindly", async () => {
    const creds = { baseUrl: "https://xt.example:8080", username: "u", password: "p" };
    const api = (action?: string) => `https://xt.example:8080/player_api.php?username=u&password=p${action ? `&action=${action}` : ""}`;
    const routes: Record<string, unknown> = {
      [api()]: { user_info: { auth: 1, status: "Active" } }, [api("get_live_categories")]: [], [api("get_live_streams")]: [{ stream_id: 7, name: "Premium One" }],
    };
    const { app } = await makeApp(routes, { opener: fakeOpen({ "https://xt.example:8080/live/u/p/7.m3u8": { status: 403 } }) });
    const src = (await app.inject({ method: "POST", url: "/v1/me/sources", headers: alice, payload: { name: "Sub", type: "xtream", url: creds.baseUrl, username: "u", password: "p", ownershipAttested: true } })).json();
    await app.inject({ method: "POST", url: `/v1/me/sources/${src.id}/sync`, headers: alice });
    const ch = (await app.inject({ url: "/v1/me/channels", headers: alice })).json()[0] as { id: string };
    expect((await diagnose(app, ch.id)).accountProblem).toBeUndefined(); // account fine: the refusal is the stream's own
    routes[api()] = { user_info: { auth: 0 } };
    const d = await diagnose(app, ch.id);
    expect(d).toMatchObject({ ok: false, cause: "auth_required", accountProblem: "login_rejected" });
    routes[api()] = { user_info: { auth: 1, status: "Expired" } };
    expect((await diagnose(app, ch.id)).accountProblem).toBe("subscription_inactive");
  });
});

describe("POST /v1/me/channels/:id/explain", () => {
  it("returns null without a model and the model's text with one", async () => {
    const { app } = await makeApp();
    const ch = await addChannel(app, "X", "https://good.example/m.m3u8");
    const none = await app.inject({ method: "POST", url: `/v1/me/channels/${ch.id}/explain`, headers: alice, payload: { lang: "ar", cause: "gone" } });
    expect(none.json()).toEqual({ text: null });
    const seen: string[] = [];
    const { app: app2 } = await makeApp({}, { model: { complete: async (_s, u) => (seen.push(u), "short") } });
    const c2 = await addChannel(app2, "X", "https://good.example/m.m3u8");
    const r = await app2.inject({ method: "POST", url: `/v1/me/channels/${c2.id}/explain`, headers: alice, payload: { lang: "en", cause: "gone", outcome: "unavailable", log: ["a", "b"] } });
    expect(r.json()).toEqual({ text: "short" });
    expect(seen[0]).toContain("cause: gone");
  });
});
