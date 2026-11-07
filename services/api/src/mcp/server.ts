import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectStreamKind, type StreamKind } from "@receiver/core";
import { z } from "zod";
import type { McpStore } from "./store";

/** Calls the platform's own API in-process as the MCP user (same validation, SSRF guards, limits and attestation rules). */
export type ApiCall = (method: "GET" | "POST" | "DELETE", url: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

export const MCP_NAME = "global-iptv-mcp";
export const MCP_VERSION = "1.0.0";

const PLAYER: Record<string, { player: string; note: string }> = {
  hls: { player: "Shaka Player or hls.js (Smart Receiver picks automatically)", note: "HLS (.m3u8)" },
  dash: { player: "Shaka Player (or dash.js)", note: "MPEG-DASH (.mpd)" },
  mp4: { player: "Browser video element", note: "Progressive MP4" },
  ts: { player: "hls.js via the server relay, or VLC", note: "MPEG-TS" },
  webm: { player: "Browser video element", note: "WebM" },
  audio: { player: "Browser audio element", note: "Audio stream" },
  unknown: { player: "Shaka Player / hls.js, or VLC", note: "Unknown format — probed at play time" },
  html: { player: "Not a media stream", note: "Web page, not playable" },
};

const playback = (url: string, webBase: string, channelId?: string) => {
  const kind: StreamKind = detectStreamKind(url);
  const p = PLAYER[kind] ?? PLAYER.unknown!;
  return { kind, format: p.note, recommended_player: p.player, ...(channelId ? { watch_url: `${webBase}/?play=${encodeURIComponent(channelId)}` } : {}) };
};

const ok = (data: unknown, summary: string) => ({ content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }], structuredContent: data as Record<string, unknown> });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });
const errOf = (r: { status: number; json: unknown }) => (r.json as { error?: string } | null)?.error ?? `HTTP ${r.status}`;

interface Channel { id: string; name: string; group?: string; country?: string; streamUrl: string; sourceId?: string; hidden: boolean; categories?: string[]; languages?: string[] }
interface CatalogEntry { id: string; name: string; country?: string; languages: string[]; categories: string[]; provenance: string; streams: { url: string; status: string }[] }

const LEGAL = "Only legal sources: open directories (iptv-org), official/FAST channels and playlists the user owns or is entitled to. No DRM circumvention, no card-sharing, no paid channels without the user's own subscription.";

export function createMcpServer(deps: { api: ApiCall; store: McpStore; userId: string; webBase: string }): McpServer {
  const { api, store, userId, webBase } = deps;
  const server = new McpServer(
    { name: MCP_NAME, version: MCP_VERSION, title: "Global IPTV MCP" },
    { instructions: `Global IPTV MCP for the Smart Receiver platform. Search, import, sync, validate and play the user's channels and the open iptv-org directory. ${LEGAL}` },
  );

  const myChannels = async (): Promise<Channel[]> => {
    const r = await api("GET", "/v1/me/channels");
    if (r.status !== 200) throw new Error(errOf(r));
    return r.json as Channel[];
  };

  // 1 ─ search_channels
  server.registerTool("search_channels", {
    title: "Search channels",
    description: "Search the user's own channels (name, group, what's on now) and/or the open iptv-org directory by text, country, category or language.",
    inputSchema: {
      query: z.string().min(1).max(200).describe("Free text, e.g. 'Al Jazeera', 'football', 'أخبار'"),
      scope: z.enum(["mine", "catalog", "both"]).default("both"),
      country: z.string().length(2).optional().describe("ISO 3166-1 alpha-2, e.g. AE"),
      category: z.string().max(40).optional().describe("iptv-org category id, e.g. news, sports, movies"),
      language: z.string().length(3).optional().describe("ISO 639-3, e.g. ara"),
      limit: z.number().int().min(1).max(50).default(20),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, scope, country, category, language, limit }) => {
    const out: { mine?: unknown[]; catalog?: unknown[] } = {};
    if (scope !== "catalog") {
      const hits = await api("GET", `/v1/search?q=${encodeURIComponent(query)}`);
      if (hits.status !== 200) return fail(`search failed: ${errOf(hits)}`);
      const byId = new Map((await myChannels()).map((c) => [c.id, c]));
      out.mine = (hits.json as { id: string }[]).map((h) => byId.get(h.id)).filter((c): c is Channel => !!c).filter((c) => !country || c.country === country.toUpperCase())
        .slice(0, limit).map((c) => ({ id: c.id, name: c.name, group: c.group, country: c.country, ...playback(c.streamUrl, webBase, c.id) }));
    }
    if (scope !== "mine") {
      const qs = new URLSearchParams({ q: query, limit: String(limit) });
      if (country) qs.set("country", country.toUpperCase());
      if (category) qs.set("category", category);
      if (language) qs.set("language", language);
      const r = await api("GET", `/v1/catalog?${qs}`);
      if (r.status !== 200) return fail(`catalog search failed: ${errOf(r)}`);
      out.catalog = (r.json as CatalogEntry[]).map((e) => ({ catalog_id: e.id, name: e.name, country: e.country, categories: e.categories, languages: e.languages, provenance: e.provenance, streams: e.streams.length }));
    }
    return ok(out, `Found ${out.mine?.length ?? 0} of your channels and ${out.catalog?.length ?? 0} directory channels for "${query}".`);
  });

  // 2 ─ discover_streams
  server.registerTool("discover_streams", {
    title: "Discover streams",
    description: "List the authorised stream URLs for a channel — from the open iptv-org directory (by catalog_id or name) or for one of the user's channels (channel_id) — with format (HLS/DASH/MP4) and the right player. Protected (DRM) streams are reported, never bypassed.",
    inputSchema: {
      catalog_id: z.string().max(120).optional(),
      query: z.string().max(200).optional().describe("Channel name to look up in the directory"),
      channel_id: z.string().max(80).optional().describe("One of the user's channels"),
      country: z.string().length(2).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ catalog_id, query, channel_id, country }) => {
    if (channel_id) {
      const r = await api("GET", `/v1/me/channels/${encodeURIComponent(channel_id)}/stream`);
      if (r.status !== 200) return fail(`channel not found: ${errOf(r)}`);
      const s = r.json as { url: string; proxy: string };
      return ok({ channel_id, url: s.url, relay_url: s.proxy, ...playback(s.url, webBase, channel_id) }, "Stream for your channel.");
    }
    const q = catalog_id ?? query;
    if (!q) return fail("Give catalog_id, query or channel_id.");
    const qs = new URLSearchParams({ q, limit: "10" });
    if (country) qs.set("country", country.toUpperCase());
    const r = await api("GET", `/v1/catalog?${qs}`);
    if (r.status !== 200) return fail(`directory lookup failed: ${errOf(r)}`);
    const entries = (r.json as CatalogEntry[]).filter((e) => !catalog_id || e.id === catalog_id);
    const out = entries.map((e) => ({
      catalog_id: e.id, name: e.name, country: e.country, provenance: e.provenance,
      streams: e.streams.map((s) => ({ url: s.url, status: s.status, ...playback(s.url, webBase) })),
    }));
    return ok({ results: out, note: LEGAL }, `${out.length} directory channel(s), ${out.reduce((n, e) => n + e.streams.length, 0)} stream(s). Use import_playlists (mode "catalog") to add them to your channels.`);
  });

  // 3 ─ import_playlists
  server.registerTool("import_playlists", {
    title: "Import playlists",
    description: "Add channels to the user's library: an M3U/M3U8 playlist URL or text the user owns or is entitled to (ownership_attested must be true), or a filtered slice of the open iptv-org directory (mode 'catalog').",
    inputSchema: {
      mode: z.enum(["m3u_url", "m3u_text", "catalog"]),
      name: z.string().min(1).max(120).describe("Group name shown in Live TV"),
      url: z.string().url().max(2000).optional(),
      content: z.string().max(5_000_000).optional(),
      ownership_attested: z.boolean().default(false).describe("Required for m3u_url / m3u_text: the user owns or is entitled to this playlist"),
      country: z.string().length(2).optional(),
      countries: z.array(z.string().length(2)).max(80).optional(),
      category: z.string().max(40).optional(),
      language: z.string().length(3).optional(),
      limit: z.number().int().min(1).max(20000).default(2000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => {
    if (a.mode === "catalog") {
      const r = await api("POST", "/v1/catalog/import", { name: a.name, limit: a.limit, country: a.country?.toUpperCase(), countries: a.countries?.map((c) => c.toUpperCase()).join(","), category: a.category, language: a.language });
      if (r.status !== 201) return fail(`import failed: ${errOf(r)}`);
      return ok(r.json, `Imported from the open directory into "${a.name}".`);
    }
    if (!a.ownership_attested) return fail("Set ownership_attested to true only if the user owns or is entitled to this playlist.");
    if (a.mode === "m3u_text") {
      if (!a.content) return fail("content is required for m3u_text.");
      const r = await api("POST", "/v1/me/playlists/import", { name: a.name, content: a.content, ownershipAttested: true });
      return r.status === 201 ? ok(r.json, `Imported playlist "${a.name}".`) : fail(`import failed: ${errOf(r)}`);
    }
    if (!a.url) return fail("url is required for m3u_url.");
    const src = await api("POST", "/v1/me/sources", { name: a.name, type: "m3u_url", url: a.url, ownershipAttested: true });
    if (src.status !== 201) return fail(`could not add source: ${errOf(src)}`);
    const id = (src.json as { id: string }).id;
    const sync = await api("POST", `/v1/me/sources/${id}/sync`);
    return sync.status === 200 ? ok({ source_id: id, ...(sync.json as object) }, `Added source "${a.name}" and synced it.`) : fail(`source added (${id}) but sync failed: ${errOf(sync)}`);
  });

  // 4 ─ sync_channels
  server.registerTool("sync_channels", {
    title: "Sync channels",
    description: "Re-sync the user's sources (M3U URLs, Xtream subscriptions they own, receivers, XMLTV guides) and optionally refresh the open iptv-org directory. New channels are added; nothing is deleted.",
    inputSchema: {
      source_id: z.string().max(80).optional().describe("Omit to sync every syncable source"),
      include_directory: z.boolean().default(false).describe("Also refresh the iptv-org directory (rate-limited server-side)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ source_id, include_directory }) => {
    const list = await api("GET", "/v1/me/sources");
    if (list.status !== 200) return fail(errOf(list));
    const sources = (list.json as { id: string; name: string; type: string; enabled: boolean }[]).filter((s) => s.enabled && s.type !== "m3u_file" && (!source_id || s.id === source_id));
    if (source_id && !sources.length) return fail("source not found or not syncable");
    const results = [];
    for (const s of sources.slice(0, 15)) {
      const r = await api("POST", `/v1/me/sources/${s.id}/sync`);
      results.push({ source_id: s.id, name: s.name, type: s.type, ok: r.status === 200, ...(r.status === 200 ? (r.json as object) : { error: errOf(r) }) });
    }
    let directory: unknown;
    if (include_directory) { const d = await api("POST", "/v1/catalog/sync"); directory = d.status === 200 ? d.json : { error: errOf(d) }; }
    return ok({ sources: results, directory }, `Synced ${results.filter((r) => r.ok).length}/${results.length} source(s).`);
  });

  // 5 ─ validate_streams
  server.registerTool("validate_streams", {
    title: "Validate streams",
    description: "Probe up to 10 of the user's channels for real playability (HTTP, manifest, segments, codecs, DRM) and record the results. Read-only towards the channels: nothing is hidden or deleted.",
    inputSchema: { channel_ids: z.array(z.string().max(80)).min(1).max(10) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ channel_ids }) => {
    const out = [];
    for (const id of channel_ids) {
      const r = await api("POST", `/v1/me/channels/${encodeURIComponent(id)}/diagnose`);
      if (r.status !== 200) { out.push({ channel_id: id, ok: false, error: errOf(r) }); continue; }
      const d = r.json as { ok: boolean; cause: string; kind: string; httpStatus?: number; latencyMs?: number; protection?: { encrypted?: boolean; drm?: string[] }; codecs?: string[] };
      await store.recordCheck(userId, { channelId: id, ok: d.ok, cause: d.cause, kind: d.kind, httpStatus: d.httpStatus, latencyMs: d.latencyMs, trigger: "tool" });
      out.push({ channel_id: id, ok: d.ok, cause: d.cause, kind: d.kind, http_status: d.httpStatus, latency_ms: d.latencyMs, codecs: d.codecs, drm_protected: !!d.protection?.encrypted,
        advice: d.ok ? "Playable." : d.protection?.encrypted ? "DRM-protected: needs the rights holder's official player/licence. Not bypassed." : "Try sync_channels or another authorised source (discover_streams)." });
    }
    return ok({ results: out }, `${out.filter((x) => x.ok).length}/${out.length} playable.`);
  });

  // 6 ─ get_epg
  server.registerTool("get_epg", {
    title: "Get EPG",
    description: "Programme guide for the user's channels: what's on now/next, or a grid for the next hours (max 48).",
    inputSchema: {
      mode: z.enum(["now_next", "grid"]).default("now_next"),
      channel_ids: z.array(z.string().max(80)).max(100).optional(),
      hours: z.number().int().min(1).max(48).default(6),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ mode, channel_ids, hours }) => {
    const want = channel_ids?.length ? new Set(channel_ids) : undefined;
    const r = mode === "now_next"
      ? await api("GET", "/v1/epg/now-next")
      : await api("GET", `/v1/epg/grid?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + hours * 3600_000).toISOString())}`);
    if (r.status !== 200) return fail(errOf(r));
    const all = r.json as Record<string, unknown>;
    const names = new Map((await myChannels()).map((c) => [c.id, c.name]));
    const data = Object.fromEntries(Object.entries(all).filter(([id]) => !want || want.has(id)).slice(0, 200).map(([id, v]) => [id, { name: names.get(id), guide: v }]));
    return ok({ mode, channels: data }, `Guide for ${Object.keys(data).length} channel(s). Channels without a matched XMLTV guide are omitted.`);
  });

  // 7 ─ list_countries
  server.registerTool("list_countries", {
    title: "List countries",
    description: "Countries (with flags and channel counts) and iptv-org regions available in the open directory.",
    inputSchema: { region: z.string().max(20).optional().describe("Region code, e.g. GCC, MAGHREB, ARAB"), with_regions: z.boolean().default(false) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ region, with_regions }) => {
    const [facets, meta] = await Promise.all([api("GET", "/v1/catalog/facets"), api("GET", "/v1/catalog/meta")]);
    if (facets.status !== 200) return fail(errOf(facets));
    const m = (meta.status === 200 ? meta.json : { regions: [], countries: {} }) as { regions: { code: string; name: string; countries: string[] }[]; countries: Record<string, { name: string; flag: string }> };
    const reg = region ? m.regions.find((r) => r.code.toUpperCase() === region.toUpperCase()) : undefined;
    if (region && !reg) return fail(`unknown region ${region}`);
    const countries = (facets.json as { countries: { value: string; count: number }[] }).countries
      .filter((c) => !reg || reg.countries.includes(c.value))
      .map((c) => ({ code: c.value, name: m.countries[c.value]?.name ?? c.value, flag: m.countries[c.value]?.flag ?? "", channels: c.count }));
    return ok({ countries, ...(with_regions ? { regions: m.regions.map((r) => ({ code: r.code, name: r.name, countries: r.countries.length })) } : {}) }, `${countries.length} countries${reg ? ` in ${reg.name}` : ""}.`);
  });

  // 8 ─ manage_favourites
  server.registerTool("manage_favourites", {
    title: "Manage favourites",
    description: "List, add or remove the user's favourite channels (stored server-side, shared across MCP clients), with the latest playability check for each.",
    inputSchema: {
      action: z.enum(["list", "add", "remove"]),
      channel_id: z.string().max(80).optional(),
      note: z.string().max(300).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ action, channel_id, note }) => {
    if (action !== "list") {
      if (!channel_id) return fail("channel_id is required");
      if (action === "remove") {
        return (await store.removeFavourite(userId, channel_id)) ? ok({ removed: channel_id }, "Removed from favourites.") : fail("not in favourites");
      }
      const ch = (await myChannels()).find((c) => c.id === channel_id);
      if (!ch) return fail("channel not found in your library (import it first)");
      await store.addFavourite(userId, { channelId: ch.id, name: ch.name, note });
    }
    const favs = await store.favourites(userId);
    const checks = await store.lastChecks(userId, favs.map((f) => f.channelId));
    const list = favs.map((f) => ({ ...f, last_check: checks[f.channelId] ?? null, watch_url: `${webBase}/?play=${encodeURIComponent(f.channelId)}` }));
    return ok({ favourites: list }, action === "add" ? `Added. ${list.length} favourite(s).` : `${list.length} favourite(s).`);
  });

  return server;
}
