import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import type { Db } from "../src/db";
import { hubFromEnv } from "../src/hub";
import { handleMcpHttp, internalIdentity, runMcpSync } from "../src/mcp";
import type { SafeOpen } from "../src/safeFetch";
import { alice, bob, makeApp } from "./helpers";

const SQL = ["supabase_hub.sql", "supabase_hub_app_role.sql", "supabase_hub_002_open_films.sql", "supabase_hub_002_role.sql", "supabase_hub_003_mcp.sql", "supabase_hub_003_role.sql"]
  .map((f) => readFileSync(new URL(`../hub/${f}`, import.meta.url), "utf8")).join("\n");
const API = "https://iptv-org.github.io/api";
const PLAYLIST = "#EXTM3U\n#EXTINF:-1 group-title=\"News\",Owned News\nhttps://cdn.example.org/news/master.m3u8\n#EXTINF:-1,Owned Movies\nhttps://cdn.example.org/movies/manifest.mpd\n";

// Every probe answers 404: validate_streams must report it (and record it) without touching the channel.
const notFound: SafeOpen = async (url) => ({ status: 404, headers: new Headers(), body: null, url });

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function setup() {
  const hubDb = new PGlite();
  await hubDb.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE hub_app;");
  await hubDb.exec(SQL);
  const hub = (await hubFromEnv({ PUBLIC_URL: "https://tv.example.org" }, { db: hubDb as unknown as Db, fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch }))!;
  const base = await makeApp({
    [`${API}/regions.json`]: [{ code: "GCC", name: "Gulf", countries: ["AE", "QA"] }],
    [`${API}/countries.json`]: [{ code: "AE", name: "United Arab Emirates", flag: "🇦🇪" }],
    [`${API}/languages.json`]: [], [`${API}/categories.json`]: [],
  }, { hub, opener: notFound });
  // The MCP's private API copy: same store/auth/hub, in-process identity only.
  const id = internalIdentity();
  const internal = buildApp({ store: base.store, auth: base.auth, authenticate: id.authenticate, secrets: base.secrets, fetcher: base.fetcher, opener: notFound, hub });
  await internal.ready();
  const http = createServer((req, res) => void handleMcpHttp(req, res, { store: hub.mcp!, app: internal, apiFor: id.apiFor, webBase: "https://tv.example.org" }));
  servers.push(http);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
  const token = (await base.app.inject({ method: "POST", url: "/v1/hub/mcp/tokens", headers: alice, payload: { label: "Claude" } })).json().token as string;
  const connect = async (bearer = token) => {
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
    return client;
  };
  return { hub, base, internal, id, url, token, connect };
}

const data = (r: unknown) => (r as { structuredContent: Record<string, unknown> }).structuredContent;

describe("Global IPTV MCP", () => {
  it("issues hashed per-user tokens and rejects missing, forged or revoked ones", async () => {
    const { hub, base, url, token, connect } = await setup();
    expect(token).toMatch(/^gim_[A-Za-z0-9_-]{43}$/);
    const raw = JSON.stringify(await hub.mcp!.db.query("SELECT * FROM hub.mcp_tokens"));
    expect(raw).not.toContain(token); // only the SHA-256 is stored
    const list = (await base.app.inject({ url: "/v1/hub/mcp", headers: alice })).json();
    expect(list).toMatchObject({ endpoint: "https://tv.example.org/mcp", tokens: [{ label: "Claude", autoSync: true }] });
    expect((await base.app.inject({ url: "/v1/hub/mcp", headers: bob })).json().tokens).toEqual([]);

    const noAuth = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("www-authenticate")).toContain("Bearer");
    await expect(connect("gim_" + "x".repeat(43))).rejects.toThrow();
    // The internal identity header cannot be used from outside: the private API copy is not reachable, and the public app ignores it.
    expect((await base.app.inject({ url: "/v1/me/channels", headers: { "x-mcp-internal": "anything:someone" } })).statusCode).toBe(401);

    const c = await connect();
    expect((await c.listTools()).tools.length).toBe(8);
    await c.close();
    await base.app.inject({ method: "DELETE", url: `/v1/hub/mcp/tokens/${list.tokens[0].id}`, headers: alice });
    await expect(connect()).rejects.toThrow();
  });

  it("exposes the 8 tools with correct read-only hints", async () => {
    const { connect } = await setup();
    const c = await connect();
    const tools = (await c.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["discover_streams", "get_epg", "import_playlists", "list_countries", "manage_favourites", "search_channels", "sync_channels", "validate_streams"]);
    const ro = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    expect(ro).toMatchObject({ search_channels: true, discover_streams: true, get_epg: true, list_countries: true, import_playlists: false });
    await c.close();
  });

  it("imports an owned playlist, searches it, reports HLS/DASH players, manages favourites and validates streams", async () => {
    const { connect } = await setup();
    const c = await connect();
    const refused = await c.callTool({ name: "import_playlists", arguments: { mode: "m3u_text", name: "Mine", content: PLAYLIST } });
    expect(refused.isError).toBe(true); // ownership must be attested
    const imported = await c.callTool({ name: "import_playlists", arguments: { mode: "m3u_text", name: "Mine", content: PLAYLIST, ownership_attested: true } });
    expect(data(imported)).toMatchObject({ imported: 2 });

    const found = data(await c.callTool({ name: "search_channels", arguments: { query: "Owned", scope: "mine" } })) as { mine: { id: string; name: string; kind: string; recommended_player: string; watch_url: string }[] };
    expect(found.mine).toHaveLength(2);
    const dash = found.mine.find((x) => x.name === "Owned Movies")!;
    const hls = found.mine.find((x) => x.name === "Owned News")!;
    expect(dash).toMatchObject({ kind: "dash", recommended_player: expect.stringContaining("Shaka") });
    expect(hls).toMatchObject({ kind: "hls", watch_url: `https://tv.example.org/?play=${hls.id}` });

    const stream = data(await c.callTool({ name: "discover_streams", arguments: { channel_id: hls.id } }));
    expect(stream).toMatchObject({ url: "https://cdn.example.org/news/master.m3u8", kind: "hls", relay_url: expect.stringContaining("/v1/proxy") });

    expect((await c.callTool({ name: "manage_favourites", arguments: { action: "add", channel_id: "nope" } })).isError).toBe(true);
    const fav = data(await c.callTool({ name: "manage_favourites", arguments: { action: "add", channel_id: hls.id, note: "daily news" } })) as { favourites: unknown[] };
    expect(fav.favourites).toEqual([expect.objectContaining({ channelId: hls.id, name: "Owned News", note: "daily news", last_check: null })]);

    const v = data(await c.callTool({ name: "validate_streams", arguments: { channel_ids: [hls.id] } })) as { results: { ok: boolean; cause: string }[] };
    expect(v.results[0]).toMatchObject({ ok: false, cause: "gone" });
    const after = data(await c.callTool({ name: "manage_favourites", arguments: { action: "list" } })) as { favourites: { last_check: { ok: boolean; trigger: string } }[] };
    expect(after.favourites[0]!.last_check).toMatchObject({ ok: false, trigger: "tool" });
    // Validation never removes or hides anything.
    expect((data(await c.callTool({ name: "search_channels", arguments: { query: "Owned", scope: "mine" } })) as { mine: unknown[] }).mine).toHaveLength(2);

    expect(data(await c.callTool({ name: "manage_favourites", arguments: { action: "remove", channel_id: hls.id } }))).toEqual({ removed: hls.id });
    await c.close();
  });

  it("lists countries with flags and regions, and returns an empty guide without XMLTV", async () => {
    const { connect } = await setup();
    const c = await connect();
    const countries = await c.callTool({ name: "list_countries", arguments: { with_regions: true } });
    expect(data(countries)).toMatchObject({ regions: [{ code: "GCC", name: "Gulf", countries: 2 }] });
    expect((await c.callTool({ name: "list_countries", arguments: { region: "NOPE" } })).isError).toBe(true);
    expect(data(await c.callTool({ name: "get_epg", arguments: {} }))).toMatchObject({ mode: "now_next", channels: {} });
    expect(data(await c.callTool({ name: "get_epg", arguments: { mode: "grid", hours: 3 } }))).toMatchObject({ mode: "grid" });
    await c.close();
  });

  it("scheduled MCP sync re-checks favourites for auto-sync users and logs the run", async () => {
    const { hub, internal, id, connect } = await setup();
    const c = await connect();
    await c.callTool({ name: "import_playlists", arguments: { mode: "m3u_text", name: "Mine", content: PLAYLIST, ownership_attested: true } });
    const mine = (data(await c.callTool({ name: "search_channels", arguments: { query: "Owned News", scope: "mine" } })) as { mine: { id: string }[] }).mine;
    await c.callTool({ name: "manage_favourites", arguments: { action: "add", channel_id: mine[0]!.id } });
    await c.close();
    const r = await runMcpSync(hub.store, hub.mcp!, (uid) => id.apiFor(internal, uid), { deadline: Date.now() + 30_000 });
    expect(r).toMatchObject({ ok: true, users: 1, checks: 1, playable: 0 });
    expect((await hub.store.jobs()).find((j) => j.job === "mcp-sync")).toMatchObject({ ok: true });
  });
});
