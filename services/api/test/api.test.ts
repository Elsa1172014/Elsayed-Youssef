import { beforeEach, describe, expect, it } from "vitest";
import { alice, bob, FIXED, makeApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeApp>>;
let app: typeof ctx.app;
beforeEach(async () => {
  ctx = await makeApp();
  app = ctx.app;
});

const M3U = `#EXTM3U\n#EXTINF:-1 tvg-id="aj.qa" group-title="News",Al Jazeera\nhttps://example.org/aj.m3u8\n#EXTINF:-1,Second\nhttps://example.org/2.m3u8\n`;

describe("auth", () => {
  it("rejects missing credentials", async () => {
    expect((await app.inject("/v1/me/channels")).statusCode).toBe(401);
    expect((await app.inject("/healthz")).statusCode).toBe(200);
  });
});

describe("sources", () => {
  it("requires ownership attestation and a public URL", async () => {
    const noAttest = await app.inject({ method: "POST", url: "/v1/me/sources", headers: alice, payload: { name: "x", type: "m3u_url" } });
    expect(noAttest.statusCode).toBe(400);
    const ssrf = await app.inject({ method: "POST", url: "/v1/me/sources", headers: alice, payload: { name: "x", type: "m3u_url", url: "http://169.254.169.254/", ownershipAttested: true } });
    expect(ssrf.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/v1/me/sources", headers: alice, payload: { name: "Mine", type: "m3u_url", url: "https://example.org/p.m3u", ownershipAttested: true } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().ownershipAttestedAt).toBe(FIXED.toISOString());
  });

  it("lets the owner edit/disable/delete and isolates users", async () => {
    const created = (await app.inject({ method: "POST", url: "/v1/me/sources", headers: alice, payload: { name: "A", type: "tuner", ownershipAttested: true } })).json();
    expect((await app.inject({ method: "PATCH", url: `/v1/me/sources/${created.id}`, headers: bob, payload: { name: "hax" } })).statusCode).toBe(404);
    const patched = await app.inject({ method: "PATCH", url: `/v1/me/sources/${created.id}`, headers: alice, payload: { name: "B", enabled: false } });
    expect(patched.json()).toMatchObject({ name: "B", enabled: false });
    expect((await app.inject({ method: "DELETE", url: `/v1/me/sources/${created.id}`, headers: alice })).statusCode).toBe(204);
  });
});

describe("channels", () => {
  it("supports add, edit, hide, reorder and delete", async () => {
    const c = (await app.inject({ method: "POST", url: "/v1/me/channels", headers: alice, payload: { name: "My TV", streamUrl: "https://example.org/s.m3u8", group: "Home" } })).json();
    const edited = await app.inject({ method: "PATCH", url: `/v1/me/channels/${c.id}`, headers: alice, payload: { name: "Renamed", hidden: true, sortOrder: 5, epgChannelId: "x" } });
    expect(edited.json()).toMatchObject({ name: "Renamed", hidden: true, sortOrder: 5, epgChannelId: "x" });
    expect((await app.inject({ method: "PATCH", url: `/v1/me/channels/${c.id}`, headers: alice, payload: { streamUrl: "file:///x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/me/channels", headers: bob })).json()).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: `/v1/me/channels/${c.id}`, headers: alice })).statusCode).toBe(204);
  });
});

describe("playlist import/export + EPG", () => {
  it("imports M3U, edits, exports, and serves now/next and a grid", async () => {
    expect((await app.inject({ method: "POST", url: "/v1/me/playlists/import", headers: alice, payload: { content: M3U } })).statusCode).toBe(400);
    const imp = await app.inject({ method: "POST", url: "/v1/me/playlists/import", headers: alice, payload: { content: M3U, ownershipAttested: true } });
    expect(imp.json()).toMatchObject({ imported: 2 });

    const channels = (await app.inject({ method: "GET", url: "/v1/me/channels", headers: alice })).json();
    await app.inject({ method: "PATCH", url: `/v1/me/channels/${channels[1].id}`, headers: alice, payload: { hidden: true } });
    const exported = (await app.inject({ method: "GET", url: "/v1/me/playlists/export.m3u", headers: alice })).body;
    expect(exported).toContain("Al Jazeera");
    expect(exported).not.toContain("Second");

    const xml = `<tv><programme start="20261011180000 +0000" stop="20261011190000 +0000" channel="aj.qa"><title>Now Show</title></programme>
      <programme start="20261011190000 +0000" stop="20261011200000 +0000" channel="aj.qa"><title>Next Show</title></programme></tv>`;
    expect((await app.inject({ method: "POST", url: "/v1/me/epg/import", headers: alice, payload: { content: xml } })).json()).toMatchObject({ programmes: 2 });
    const nn = (await app.inject({ method: "GET", url: "/v1/epg/now-next", headers: alice })).json();
    expect(nn[channels[0].id].now.title).toBe("Now Show");
    expect(nn[channels[0].id].next.title).toBe("Next Show");

    const grid = (await app.inject({ url: "/v1/epg/grid?from=2026-10-11T18:00:00Z&to=2026-10-11T21:00:00Z", headers: alice })).json();
    expect(grid[channels[0].id].map((p: { title: string }) => p.title)).toEqual(["Now Show", "Next Show"]);
    expect((await app.inject({ url: "/v1/epg/grid?from=2026-10-11T18:00:00Z&to=2026-10-20T21:00:00Z", headers: alice })).statusCode).toBe(400);
  });

  it("merges guide sources by priority", async () => {
    await app.inject({ method: "POST", url: "/v1/me/channels", headers: alice, payload: { name: "C", streamUrl: "https://example.org/c.m3u8", epgChannelId: "c" } });
    const tv = (title: string) => `<tv><programme start="20261011180000 +0000" stop="20261011190000 +0000" channel="c"><title>${title}</title></programme></tv>`;
    await app.inject({ method: "POST", url: "/v1/me/epg/import", headers: alice, payload: { content: tv("Community"), sourceKey: "community", priority: 10 } });
    await app.inject({ method: "POST", url: "/v1/me/epg/import", headers: alice, payload: { content: tv("Official"), sourceKey: "official", priority: 30 } });
    const nn = Object.values((await app.inject({ url: "/v1/epg/now-next", headers: alice })).json())[0] as { now: { title: string } };
    expect(nn.now.title).toBe("Official");
  });
});

describe("discovery", () => {
  it("searches, recommends from watch history, suggests EPG mappings, and clears history", async () => {
    await app.inject({ method: "POST", url: "/v1/me/playlists/import", headers: alice, payload: {
      ownershipAttested: true,
      content: `#EXTM3U\n#EXTINF:-1 group-title="News",Al Jazeera\nhttps://example.org/1\n#EXTINF:-1 group-title="News",Sky News Arabia\nhttps://example.org/2\n#EXTINF:-1 group-title="Kids",Cartoons\nhttps://example.org/3\n`,
    } });
    const ch = (await app.inject({ url: "/v1/me/channels", headers: alice })).json() as { id: string; name: string }[];
    const aj = ch.find((c) => c.name === "Al Jazeera")!;
    const sky = ch.find((c) => c.name.startsWith("Sky"))!;

    const found = (await app.inject({ url: "/v1/search?q=jazeera", headers: alice })).json();
    expect(found[0].id).toBe(aj.id);
    const fuzzy = (await app.inject({ url: "/v1/search?q=skynews", headers: alice })).json();
    expect(fuzzy[0].id).toBe(sky.id); // embedding side catches the spelling variant
    expect((await app.inject({ url: "/v1/search", headers: alice })).statusCode).toBe(400);

    expect((await app.inject({ method: "POST", url: "/v1/me/watch-events", headers: alice, payload: { channelId: "nope", seconds: 60 } })).statusCode).toBe(404);
    await app.inject({ method: "POST", url: "/v1/me/watch-events", headers: alice, payload: { channelId: aj.id, seconds: 1800 } });
    const recs = (await app.inject({ url: "/v1/recommendations", headers: alice })).json();
    expect(recs[0].id).toBe(sky.id);
    expect((await app.inject({ url: "/v1/recommendations", headers: bob })).json()).toEqual([]);

    await app.inject({ method: "POST", url: "/v1/me/epg/import", headers: alice, payload: { content: `<tv><channel id="aj.qa"><display-name>Al Jazeera</display-name></channel></tv>` } });
    const sugg = (await app.inject({ url: "/v1/me/epg/suggestions", headers: alice })).json();
    expect(sugg).toEqual([expect.objectContaining({ channelId: aj.id, epgChannelId: "aj.qa" })]);

    expect((await app.inject({ method: "DELETE", url: "/v1/me/watch-events", headers: alice })).statusCode).toBe(204);
    expect((await app.inject({ url: "/v1/recommendations", headers: alice })).json()).toEqual([]);
  });
});
