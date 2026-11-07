import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { syncArchive, syncSports, syncTmdb, type HubClients } from "./jobs";
import type { HubStore } from "./store";
import type { McpStore } from "../mcp/store";

export interface Hub {
  store: HubStore;
  clients: HubClients;
  /** Usernames allowed into the Hub admin panel (HUB_ADMIN_USERS, comma-separated). */
  admins: string[];
  /** Which provider keys are configured (booleans only — values never leave the server). */
  keys: { tmdb: boolean; sportsdbOwnKey: boolean; supabase: boolean };
  /** Global IPTV MCP tokens, favourites and checks (same Supabase schema). */
  mcp?: McpStore;
  /** Public base URL of the site (for the MCP endpoint and watch links). */
  publicUrl?: string;
}

const DRM = ["widevine", "playready", "fairplay", "clearkey"] as const;
const KINDS = ["hls", "dash", "mp4"] as const;
const https = (v: unknown, max = 2000): string | undefined => (typeof v === "string" && v.length <= max && /^https:\/\/[^\s]+$/i.test(v) ? v : undefined);
const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const bad = (reply: FastifyReply, error: string, code = 400) => reply.code(code).send({ error });

export function registerHub(
  app: FastifyInstance,
  deps: { hub?: Hub; uidOf: (req: FastifyRequest) => string; usernameOf: (uid: string) => Promise<string | undefined> },
) {
  const { hub } = deps;
  const body = (req: FastifyRequest) => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
  const isAdmin = async (req: FastifyRequest) => {
    if (!hub || !hub.admins.length) return false;
    const name = await deps.usernameOf(deps.uidOf(req));
    return !!name && hub.admins.includes(name.toLowerCase());
  };
  const needHub = (reply: FastifyReply): boolean => {
    if (!hub) { void bad(reply, "Entertainment Hub is not configured on the server (SUPABASE_DB_URL)", 503); return false; }
    return true;
  };
  const needAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!needHub(reply)) return false;
    if (!(await isAdmin(req))) { void bad(reply, "Admins only", 403); return false; }
    return true;
  };

  app.get("/v1/hub/status", async (req) => {
    if (!hub) return { enabled: false, isAdmin: false, keys: { tmdb: false, sportsdbOwnKey: false, supabase: false }, region: undefined };
    return { enabled: true, isAdmin: await isAdmin(req), keys: hub.keys, region: hub.clients.region, adminsConfigured: hub.admins.length > 0 };
  });

  // ---------------- library ----------------
  app.get("/v1/hub/titles", async (req, reply) => {
    if (!needHub(reply)) return;
    const q = req.query as Record<string, string | undefined>;
    const kind = q.kind === "movie" || q.kind === "tv" ? q.kind : undefined;
    const source = q.source === "tmdb" || q.source === "archive" || q.source === "own" ? q.source : undefined;
    return hub!.store.listTitles({ kind, source, q: text(q.q, 80), licensedOnly: q.licensed === "1", limit: Number(q.limit) || 40, offset: Number(q.offset) || 0 });
  });

  app.get("/v1/hub/titles/:id", async (req, reply) => {
    if (!needHub(reply)) return;
    const id = Number((req.params as { id: string }).id);
    const t = Number.isInteger(id) ? await hub!.store.getTitle(id) : undefined;
    if (!t) return bad(reply, "Not found", 404);
    const sources = await hub!.store.sourcesFor(id, true);
    // Viewers get what the player needs; rights paperwork stays in the admin view.
    return { ...t, sources: sources.map(({ id: sid, label, url, kind, drmSystem, licenseUrl }) => ({ id: sid, label, url, kind, drmSystem, licenseUrl })) };
  });

  // ---------------- matches ----------------
  app.get("/v1/hub/matches", async (req, reply) => {
    if (!needHub(reply)) return;
    const q = req.query as Record<string, string | undefined>;
    return hub!.store.events({ range: q.range === "recent" ? "recent" : "upcoming", league: text(q.league, 20), limit: Number(q.limit) || 60 });
  });

  app.get("/v1/hub/leagues", async (_req, reply) => (needHub(reply) ? hub!.store.leagues(true) : undefined));

  // ---------------- Global IPTV MCP: per-user tokens ----------------
  app.get("/v1/hub/mcp", async (req, reply) => {
    if (!needHub(reply)) return;
    if (!hub!.mcp) return bad(reply, "MCP is not enabled", 503);
    return { endpoint: `${hub!.publicUrl ?? ""}/mcp`, tokens: await hub!.mcp.listTokens(deps.uidOf(req)) };
  });

  /** The raw token is returned once; only its SHA-256 is stored. */
  app.post("/v1/hub/mcp/tokens", async (req, reply) => {
    if (!needHub(reply)) return;
    if (!hub!.mcp) return bad(reply, "MCP is not enabled", 503);
    const uid = deps.uidOf(req);
    if ((await hub!.mcp.listTokens(uid)).length >= 5) return bad(reply, "You already have 5 active tokens; revoke one first", 409);
    const r = await hub!.mcp.createToken(uid, text(body(req).label, 60) ?? "MCP");
    return reply.code(201).header("cache-control", "no-store").send(r);
  });

  app.delete("/v1/hub/mcp/tokens/:id", async (req, reply) => {
    if (!needHub(reply) || !hub!.mcp) return;
    return (await hub!.mcp.revokeToken(deps.uidOf(req), Number((req.params as { id: string }).id))) ? reply.code(204).send() : bad(reply, "Not found", 404);
  });

  app.patch("/v1/hub/mcp/tokens/:id", async (req, reply) => {
    if (!needHub(reply) || !hub!.mcp) return;
    await hub!.mcp.setAutoSync(deps.uidOf(req), Number((req.params as { id: string }).id), body(req).autoSync === true);
    return reply.code(204).send();
  });

  // ---------------- admin ----------------
  app.get("/v1/hub/admin/overview", async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    const [counts, jobs, errors, leagues] = await Promise.all([hub!.store.counts(), hub!.store.jobs(20), hub!.store.errors(40), hub!.store.leagues()]);
    return { counts, jobs, errors, leagues, keys: hub!.keys, region: hub!.clients.region };
  });

  app.post("/v1/hub/admin/sync", async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    const job = body(req).job;
    if (job !== "tmdb" && job !== "sports" && job !== "archive") return bad(reply, "job must be tmdb, sports or archive");
    // (mcp-sync runs from the cron with in-process API access; see deploy/vercel/src/hubCron.ts)
    return job === "tmdb" ? syncTmdb(hub!.store, hub!.clients, "manual") : job === "sports" ? syncSports(hub!.store, hub!.clients, "manual") : syncArchive(hub!.store, hub!.clients, "manual");
  });

  app.get("/v1/hub/admin/tmdb/search", async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    if (!hub!.clients.tmdb) return bad(reply, "TMDB key is not configured", 503);
    const q = text((req.query as Record<string, string>).q, 100);
    if (!q) return bad(reply, "q is required");
    return (await hub!.clients.tmdb.search(q)).slice(0, 20);
  });

  app.post("/v1/hub/admin/titles", async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    const b = body(req);
    const kind = b.kind === "movie" || b.kind === "tv" ? b.kind : undefined;
    const tmdbId = Number(b.tmdbId);
    if (!kind || !Number.isInteger(tmdbId) || tmdbId <= 0) return bad(reply, "kind (movie|tv) and tmdbId are required");
    if (!hub!.clients.tmdb) return bad(reply, "TMDB key is not configured", 503);
    const t = await hub!.clients.tmdb.details(kind, tmdbId);
    if (!t) return bad(reply, "Not found on TMDB", 404);
    const genres = await hub!.clients.tmdb.genres().catch(() => ({} as Record<number, string>));
    const id = await hub!.store.upsertTitle(t, t.genreIds.map((g) => genres[g]).filter((g): g is string => !!g));
    await hub!.store.setFeatured(id, true);
    try {
      await hub!.store.setProviders(id, await hub!.clients.tmdb.watchProviders(kind, tmdbId, hub!.clients.region), hub!.clients.region);
    } catch (e) { await hub!.store.logError("tmdb", (e as Error).message, { tmdbId }, "admin"); }
    return reply.code(201).send(await hub!.store.getTitle(id));
  });

  /** The operator's own film (or one licensed to them), added by an https link with the rights attested. */
  app.post("/v1/hub/admin/own-titles", async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    const b = body(req);
    if (b.rightsAttested !== true) return bad(reply, "Confirm that you own this film or hold the rights to show it");
    const title = text(b.title, 200);
    const url = https(b.url);
    const kind = b.kind === "tv" ? "tv" : "movie";
    const posterUrl = b.posterUrl ? https(b.posterUrl, 1000) : undefined;
    const rightsHolder = text(b.rightsHolder, 120);
    const licenseRef = text(b.licenseRef, 200) ?? "Owner";
    if (!title || !url || !rightsHolder) return bad(reply, "title, an https url and rightsHolder are required");
    if (b.posterUrl && !posterUrl) return bad(reply, "posterUrl must be https");
    const year = Number(b.year);
    const play = { label: text(b.label, 80) ?? "مشاهدة", url, kind: (/\.mpd(\?|$)/i.test(url) ? "dash" : /\.m3u8(\?|$)/i.test(url) ? "hls" : "mp4") as "hls" | "dash" | "mp4", rightsHolder, licenseRef, createdBy: (await deps.usernameOf(deps.uidOf(req))) ?? "admin" };
    const id = await hub!.store.upsertOpenTitle({ source: "own", externalId: randomUUID(), kind, title, overview: text(b.overview, 1500), posterUrl, releaseYear: year > 1880 && year < 2100 ? year : undefined, genres: ["أفلامي"], play });
    return reply.code(201).send(await hub!.store.getTitle(id));
  });

  app.delete("/v1/hub/admin/titles/:id", async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    return (await hub!.store.deleteTitle(Number((req.params as { id: string }).id))) ? reply.code(204).send() : bad(reply, "Not found", 404);
  });

  app.get("/v1/hub/admin/titles/:id/sources", async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    return hub!.store.sourcesFor(Number((req.params as { id: string }).id), false);
  });

  /** A licensed source: the operator attests the rights; DRM only through the rights holder's official license server. */
  app.post("/v1/hub/admin/titles/:id/sources", async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    const titleId = Number((req.params as { id: string }).id);
    if (!(await hub!.store.getTitle(titleId))) return bad(reply, "Title not found", 404);
    const b = body(req);
    if (b.rightsAttested !== true) return bad(reply, "Confirm that you hold the rights or licence to show this source");
    const url = https(b.url);
    const label = text(b.label, 80);
    const rightsHolder = text(b.rightsHolder, 120);
    const licenseRef = text(b.licenseRef, 200);
    const kind = KINDS.find((k) => k === b.kind) ?? (url && /\.mpd(\?|$)/i.test(url) ? "dash" : url && /\.mp4(\?|$)/i.test(url) ? "mp4" : "hls");
    const drmSystem = DRM.find((d) => d === b.drmSystem);
    const licenseUrl = b.licenseUrl ? https(b.licenseUrl) : undefined;
    if (!url || !label || !rightsHolder || !licenseRef) return bad(reply, "label, an https url, rightsHolder and licenseRef are required");
    if (!!drmSystem !== !!licenseUrl) return bad(reply, "A DRM source needs both its system and the rights holder's https license server URL");
    const validUntil = typeof b.validUntil === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.validUntil) ? b.validUntil : undefined;
    const createdBy = (await deps.usernameOf(deps.uidOf(req))) ?? "admin";
    return reply.code(201).send(await hub!.store.addSource({ titleId, label, url, kind, drmSystem, licenseUrl, rightsHolder, licenseRef, validUntil, createdBy }));
  });

  app.patch("/v1/hub/admin/sources/:id", async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    await hub!.store.setSourceEnabled(Number((req.params as { id: string }).id), body(req).enabled === true);
    return reply.code(204).send();
  });

  app.delete("/v1/hub/admin/sources/:id", async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    return (await hub!.store.deleteSource(Number((req.params as { id: string }).id))) ? reply.code(204).send() : bad(reply, "Not found", 404);
  });

  app.post("/v1/hub/admin/leagues", async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    const id = text(body(req).id, 12);
    if (!id || !/^\d+$/.test(id)) return bad(reply, "id must be a TheSportsDB league id (digits)");
    const l = await hub!.clients.sports.league(id).catch(() => undefined);
    if (!l) return bad(reply, "League not found on TheSportsDB", 404);
    await hub!.store.addLeague(l);
    return reply.code(201).send(l);
  });

  app.delete("/v1/hub/admin/leagues/:id", async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    await hub!.store.removeLeague((req.params as { id: string }).id);
    return reply.code(204).send();
  });
}
