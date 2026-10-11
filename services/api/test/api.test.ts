import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { devAuthenticator } from "../src/auth";
import { MemoryStore } from "../src/store";

const alice = { authorization: "Bearer dev:alice" };
const bob = { authorization: "Bearer dev:bob" };
const FIXED = new Date("2026-10-11T18:30:00Z");

let app: ReturnType<typeof buildApp>;
beforeEach(() => {
  app = buildApp({ store: new MemoryStore(), authenticate: devAuthenticator(), now: () => FIXED });
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
    const created = (await app.inject({ method: "POST", url: "/v1/me/sources", headers: alice, payload: { name: "A", type: "xtream", ownershipAttested: true } })).json();
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
  it("imports M3U, edits, exports, and serves now/next", async () => {
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
  });
});
