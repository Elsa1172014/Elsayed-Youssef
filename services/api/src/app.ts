import { syncIptvOrg } from "./jobs/catalog";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  assertPublicHttpUrl, fillCredentials, fuseRankings, hashingEmbedder, mergeProgrammes, nearest, parseM3U, parseXmltv,
  matchOwnChannels, parseXtreamLive, rankStreams, recommend, searchChannels, serializeM3U, suggestEpgMappings, xtreamApiUrl, xtreamAuthOk,
  xtreamStreamTemplate, type M3UEntry,
} from "@receiver/core";
import { clip, LANGS, plainSummary, SUMMARY_SYSTEM, TRANSLATE_SYSTEM, type Lang, type TextModel } from "./ai";
import { AuthError, bearerToken, type AuthService, type Authenticator } from "./auth";
import { AttemptLimiter } from "./rateLimit";
import type { SecretBox } from "./crypto";
import { createSafeOpen, type SafeFetch, type SafeOpen } from "./safeFetch";
import { randomProxyKey, relay, signProxyUrl, verifyProxyQuery } from "./hlsProxy";
import type { SourceType, Store, UserChannel, UserSource } from "./store";

const SOURCE_TYPES: SourceType[] = ["m3u_url", "m3u_file", "xtream", "xmltv", "tuner"];
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const embedder = hashingEmbedder();

interface Deps {
  store: Store;
  auth: AuthService;
  authenticate: Authenticator;
  /** Comma-separated browser origins allowed to call the API cross-origin (e.g. packaged TV apps). */
  allowedOrigins?: string[];
  trustProxy?: boolean;
  /** Optional text model for AI helpers; without it summaries use a rule-based fallback and translation is unavailable. */
  model?: TextModel;
  secrets: SecretBox;
  fetcher: SafeFetch;
  /** Streaming, SSRF-guarded fetcher used by the HLS relay (`/v1/proxy`). */
  opener?: SafeOpen;
  /** HMAC key for relay URLs; must be identical across instances (derived from SECRET_KEY). */
  proxyKey?: Buffer;
  /** Base URL of the iptv-org API used by the in-app "Sync now" button (tests point it at a fake). */
  catalogApi?: string;
  now?: () => Date;
}

const bad = (reply: FastifyReply, message: string, code = 400) => reply.code(code).send({ error: message });
const str = (v: unknown, max = 500): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
const clampPriority = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100 ? (v as number) : 20);

interface Creds {
  baseUrl: string;
  username: string;
  password: string;
}

export function buildApp({ store, auth, authenticate, secrets, fetcher, opener = createSafeOpen(), proxyKey = randomProxyKey(), allowedOrigins = [], trustProxy = false, model, catalogApi, now = () => new Date() }: Deps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: MAX_BODY_BYTES, trustProxy });
  // Browsers/clients often send `content-type: application/json` on body-less POST/DELETE; Fastify's default parser
  // answers that with 400 "Bad Request". Treat an empty body as {} and keep the default parser (with its
  // prototype-poisoning protection) for everything else.
  const jsonParser = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => (body === "" ? done(null, {}) : jsonParser(req, body as string, done)));
  const loginLimiter = new AttemptLimiter(5, 15 * 60_000, () => now().getTime());
  const aiLimiter = new AttemptLimiter(60, 3600_000, () => now().getTime()); // per user per hour: bounds model cost
  const registerLimiter = new AttemptLimiter(10, 60 * 60_000, () => now().getTime());

  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      reply.header("access-control-allow-origin", origin).header("vary", "origin")
        .header("access-control-allow-headers", "authorization, content-type")
        .header("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") return reply.code(204).send();
  });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
  });

  app.get("/healthz", async () => ({ ok: true }));

  const PUBLIC = new Set(["/healthz", "/v1/proxy", "/v1/auth/register", "/v1/auth/login"]);
  app.addHook("preHandler", async (req, reply) => {
    if (PUBLIC.has(req.url.split("?")[0]!)) return;
    const uid = await authenticate(req);
    if (!uid) return bad(reply, "Unauthorized", 401);
    (req as FastifyRequest & { uid: string }).uid = uid;
  });
  const uidOf = (req: FastifyRequest) => (req as FastifyRequest & { uid: string }).uid;
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;

  // ---- Accounts (username + password) ----
  const authFail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof AuthError) return bad(reply, e.message, e.status);
    throw e;
  };

  app.post("/v1/auth/register", async (req, reply) => {
    const wait = registerLimiter.blockedFor(req.ip);
    if (wait) return reply.header("retry-after", wait).code(429).send({ error: "Too many sign-up attempts, try again later" });
    registerLimiter.fail(req.ip); // every registration attempt counts, successful or not
    try {
      const b = body(req);
      return reply.code(201).send(await auth.register(b.username, b.password));
    } catch (e) {
      return authFail(reply, e);
    }
  });

  app.post("/v1/auth/login", async (req, reply) => {
    const b = body(req);
    const name = typeof b.username === "string" ? b.username.toLowerCase().slice(0, 64) : "";
    const keys = [`u:${name}`, `ip:${req.ip}`];
    const wait = Math.max(...keys.map((k) => loginLimiter.blockedFor(k)));
    if (wait) return reply.header("retry-after", wait).code(429).send({ error: "Too many failed attempts, try again later" });
    try {
      const r = await auth.login(b.username, b.password);
      loginLimiter.reset(keys[0]!);
      return r;
    } catch (e) {
      if (e instanceof AuthError && e.status === 401) keys.forEach((k) => loginLimiter.fail(k));
      return authFail(reply, e);
    }
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    await auth.logout(bearerToken(req)!);
    return reply.code(204).send();
  });

  app.get("/v1/me", async (req, reply) => (await auth.me(uidOf(req))) ?? bad(reply, "Not found", 404));

  app.post("/v1/auth/password", async (req, reply) => {
    const b = body(req);
    try {
      await auth.changePassword(uidOf(req), b.currentPassword, b.newPassword, bearerToken(req)!);
      return reply.code(204).send();
    } catch (e) {
      return authFail(reply, e);
    }
  });

  // Deletes the account and all of its data. Requires the password.
  app.delete("/v1/me", async (req, reply) => {
    try {
      await auth.deleteAccount(uidOf(req), body(req).password);
      return reply.code(204).send();
    } catch (e) {
      return authFail(reply, e);
    }
  });

  const credsOf = async (uid: string, src: UserSource): Promise<Creds | undefined> => {
    const sealed = await store.getSourceSecret(uid, src.id);
    return sealed ? (JSON.parse(secrets.open(sealed)) as Creds) : undefined;
  };
  /** Resolves credential placeholders in a stored stream URL using the owning source's secret. */
  const resolveStream = async (uid: string, c: UserChannel): Promise<string> => {
    if (!c.streamUrl.includes("{username}") || !c.sourceId) return c.streamUrl;
    const src = await store.getSource(uid, c.sourceId);
    const creds = src && (await credsOf(uid, src));
    return creds ? fillCredentials(c.streamUrl, creds) : c.streamUrl;
  };

  // ---- Sources (user-owned; legal attestation required) ----
  app.get("/v1/me/sources", async (req) => store.listSources(uidOf(req)));

  app.post("/v1/me/sources", async (req, reply) => {
    const b = body(req);
    const name = str(b.name, 120);
    if (!name) return bad(reply, "name is required");
    if (!SOURCE_TYPES.includes(b.type as SourceType)) return bad(reply, "invalid type");
    if (b.ownershipAttested !== true) return bad(reply, "You must attest that you own or are entitled to use this source");
    let url: string | undefined;
    if (b.url !== undefined) {
      try {
        url = assertPublicHttpUrl(String(b.url)).toString();
      } catch (e) {
        return bad(reply, (e as Error).message);
      }
    }
    let sealed: string | undefined;
    if (b.type === "xtream") {
      const username = str(b.username, 200);
      const password = str(b.password, 200);
      if (!url || !username || !password) return bad(reply, "Xtream sources need url, username and password");
      sealed = secrets.seal(JSON.stringify({ baseUrl: url, username, password } satisfies Creds));
    }
    const row = await store.addSource(
      { userId: uidOf(req), type: b.type as SourceType, name, enabled: true, url, ownershipAttestedAt: now().toISOString() },
      sealed,
    );
    return reply.code(201).send(row);
  });

  app.patch("/v1/me/sources/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = body(req);
    const patch: { name?: string; enabled?: boolean; url?: string } = {};
    if (b.name !== undefined) {
      const n = str(b.name, 120);
      if (!n) return bad(reply, "invalid name");
      patch.name = n;
    }
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== "boolean") return bad(reply, "invalid enabled");
      patch.enabled = b.enabled;
    }
    if (b.url !== undefined) {
      try {
        patch.url = assertPublicHttpUrl(String(b.url)).toString();
      } catch (e) {
        return bad(reply, (e as Error).message);
      }
    }
    const row = await store.updateSource(uidOf(req), id, patch);
    return row ?? bad(reply, "Not found", 404);
  });

  app.delete("/v1/me/sources/:id", async (req, reply) => {
    const ok = await store.deleteSource(uidOf(req), (req.params as { id: string }).id);
    return ok ? reply.code(204).send() : bad(reply, "Not found", 404);
  });

  /**
   * Refreshes a source's channel list or guide from the user's own provider (metadata only; no media).
   * Re-sync only ADDS channels it has not seen, so the user's renames, hides and reordering are never overwritten.
   */
  app.post("/v1/me/sources/:id/sync", async (req, reply) => {
    const uid = uidOf(req);
    const src = await store.getSource(uid, (req.params as { id: string }).id);
    if (!src) return bad(reply, "Not found", 404);
    if (!src.enabled) return bad(reply, "Source is disabled", 409);
    const existing = new Set((await store.listChannels(uid)).filter((c) => c.sourceId === src.id).map((c) => c.streamUrl));
    let order = await store.nextSortOrder(uid);
    const fresh: Omit<UserChannel, "id">[] = [];
    const addNew = async (c: Omit<UserChannel, "id" | "userId" | "sourceId" | "sortOrder" | "hidden">) => {
      if (existing.has(c.streamUrl)) return;
      existing.add(c.streamUrl);
      fresh.push({ ...c, userId: uid, sourceId: src.id, sortOrder: order++, hidden: false });
    };
    try {
      if (src.type === "xtream") {
        const creds = await credsOf(uid, src);
        if (!creds) return bad(reply, "Missing credentials", 409);
        const get = async (action?: string) => JSON.parse(await (await fetcher(xtreamApiUrl(creds, action))).text()) as unknown;
        if (!xtreamAuthOk(await get())) return bad(reply, "The provider did not accept these credentials or the subscription is not active", 502);
        const channels = parseXtreamLive(await get("get_live_categories"), await get("get_live_streams"));
        for (const c of channels) {
          await addNew({ name: c.name, logoUrl: c.logo, group: c.categoryName, epgChannelId: c.epgChannelId, streamUrl: xtreamStreamTemplate(creds.baseUrl, c.streamId) });
        }
      } else if (src.type === "m3u_url" && src.url) {
        const res = await fetcher(src.url, { signal: AbortSignal.timeout(25_000) });
        if (!res.ok) return bad(reply, `Source returned HTTP ${res.status}`, 502);
        for (const e of parseM3U(await res.text()).entries) {
          await addNew({ name: e.name, streamUrl: e.url, logoUrl: e.tvgLogo, group: e.groupTitle, epgChannelId: e.tvgId });
        }
      } else if (src.type === "xmltv" && src.url) {
        const res = await fetcher(src.url, { signal: AbortSignal.timeout(25_000) });
        if (!res.ok) return bad(reply, `Source returned HTTP ${res.status}`, 502);
        const g = parseXmltv(await res.text());
        await store.replaceGuide(uid, `src:${src.id}`, 20, g.channels, g.programmes);
        await store.updateSource(uid, src.id, { lastSyncAt: now().toISOString() });
        return { programmes: g.programmes.length, channels: g.channels.length };
      } else {
        return bad(reply, "This source type has nothing to sync", 400);
      }
    } catch (e) {
      return bad(reply, `Sync failed: ${(e as Error).message}`, 502);
    }
    try {
      await store.addChannels(fresh);
    } catch (e) {
      return bad(reply, `Saving channels failed: ${(e as Error).message}`, 500);
    }
    await store.updateSource(uid, src.id, { lastSyncAt: now().toISOString() });
    return { added: fresh.length };
  });

  // ---- Channels (full user editing control) ----
  /** What the server actually has saved for this account: lets the app say "0 saved" vs "still loading" instead of guessing. */
  app.get("/v1/me/stats", async (req) => {
    const uid = uidOf(req);
    return { channels: await store.countChannels(uid), sources: (await store.listSources(uid)).length, catalog: await store.countCatalog({}) };
  });

  /** Without `limit` returns everything (small accounts, exports); clients page with limit/offset so a 10k-channel list never hits response-size or time limits. */
  app.get("/v1/me/channels", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const uid = uidOf(req);
    const limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit <= 0) return store.listChannels(uid);
    reply.header("x-total-count", await store.countChannels(uid));
    return store.listChannels(uid, { limit: Math.min(limit, 2000), offset: Math.max(Number(q.offset) || 0, 0) });
  });

  app.post("/v1/me/channels", async (req, reply) => {
    const b = body(req);
    const name = str(b.name, 200);
    if (!name) return bad(reply, "name is required");
    let streamUrl: string;
    try {
      streamUrl = assertPublicHttpUrl(String(b.streamUrl)).toString();
    } catch (e) {
      return bad(reply, (e as Error).message);
    }
    const uid = uidOf(req);
    const row = await store.addChannel({
      userId: uid, name, streamUrl, logoUrl: str(b.logoUrl, 1000), group: str(b.group, 120),
      epgChannelId: str(b.epgChannelId, 200), sortOrder: await store.nextSortOrder(uid), hidden: false,
    });
    return reply.code(201).send(row);
  });

  app.patch("/v1/me/channels/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = body(req);
    const patch: Partial<Omit<UserChannel, "id" | "userId" | "sourceId">> = {};
    if (b.name !== undefined) {
      const n = str(b.name, 200);
      if (!n) return bad(reply, "invalid name");
      patch.name = n;
    }
    for (const k of ["logoUrl", "group", "epgChannelId"] as const) {
      if (b[k] !== undefined) patch[k] = b[k] === null ? undefined : str(b[k], 1000);
    }
    if (b.streamUrl !== undefined) {
      try {
        patch.streamUrl = assertPublicHttpUrl(String(b.streamUrl)).toString();
      } catch (e) {
        return bad(reply, (e as Error).message);
      }
    }
    if (b.sortOrder !== undefined) {
      if (!Number.isInteger(b.sortOrder)) return bad(reply, "invalid sortOrder");
      patch.sortOrder = b.sortOrder as number;
    }
    if (b.hidden !== undefined) {
      if (typeof b.hidden !== "boolean") return bad(reply, "invalid hidden");
      patch.hidden = b.hidden;
    }
    return (await store.updateChannel(uidOf(req), id, patch)) ?? bad(reply, "Not found", 404);
  });

  app.delete("/v1/me/channels/:id", async (req, reply) => {
    return (await store.deleteChannel(uidOf(req), (req.params as { id: string }).id)) ? reply.code(204).send() : bad(reply, "Not found", 404);
  });

  /** Playable URL for the client (credentials filled in for the owner's own Xtream account). */
  app.get("/v1/me/channels/:id/stream", async (req, reply) => {
    const uid = uidOf(req);
    const c = await store.getChannel(uid, (req.params as { id: string }).id);
    if (!c) return bad(reply, "Not found", 404);
    const url = await resolveStream(uid, c);
    return { url, proxy: signProxyUrl(proxyKey, url, now().getTime()) };
  });

  /** Signed HLS relay (see hlsProxy.ts). Authorised by the signature, not the session, so players can fetch segments directly. */
  app.get("/v1/proxy", async (req, reply) => {
    const url = verifyProxyQuery(proxyKey, req.query as Record<string, unknown>, now().getTime());
    if (!url) return bad(reply, "Invalid or expired link", 403);
    const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
    const r = await relay(opener, url, (u) => signProxyUrl(proxyKey, u, now().getTime()), range);
    return reply.code(r.status).headers(r.headers).send(r.body);
  });

  // ---- Playlist import / export ----
  app.post("/v1/me/playlists/import", async (req, reply) => {
    const b = body(req);
    const content = typeof b.content === "string" ? b.content : undefined;
    if (!content) return bad(reply, "content (M3U text) is required");
    if (b.ownershipAttested !== true) return bad(reply, "You must attest that you own or are entitled to use this playlist");
    const uid = uidOf(req);
    const parsed = parseM3U(content);
    const source = await store.addSource({ userId: uid, type: "m3u_file", name: str(b.name, 120) ?? "Imported playlist", enabled: true, ownershipAttestedAt: now().toISOString() });
    let order = await store.nextSortOrder(uid);
    await store.addChannels(parsed.entries.map((e) => ({ userId: uid, sourceId: source.id, name: e.name, streamUrl: e.url, logoUrl: e.tvgLogo, group: e.groupTitle, epgChannelId: e.tvgId, sortOrder: order++, hidden: false })));
    return reply.code(201).send({ sourceId: source.id, imported: parsed.entries.length, warnings: parsed.warnings, epgUrls: parsed.epgUrls });
  });

  app.get("/v1/me/playlists/export.m3u", async (req, reply) => {
    const uid = uidOf(req);
    const entries: M3UEntry[] = [];
    for (const c of (await store.listChannels(uid)).filter((x) => !x.hidden)) {
      entries.push({ name: c.name, url: await resolveStream(uid, c), duration: -1, tvgId: c.epgChannelId, tvgLogo: c.logoUrl, groupTitle: c.group, attrs: {} });
    }
    return reply.header("content-type", "audio/x-mpegurl; charset=utf-8").send(serializeM3U(entries));
  });

  // ---- EPG ----
  app.post("/v1/me/epg/import", async (req, reply) => {
    const b = body(req);
    if (typeof b.content !== "string" || !b.content) return bad(reply, "content (XMLTV text) is required");
    const r = parseXmltv(b.content);
    await store.replaceGuide(uidOf(req), str(b.sourceKey, 80) ? `manual:${b.sourceKey as string}` : "manual", clampPriority(b.priority), r.channels, r.programmes);
    return reply.code(201).send({ channels: r.channels.length, programmes: r.programmes.length, warnings: r.warnings.length });
  });

  const programmesFor = async (uid: string, epgChannelId: string, from: string, to: string) =>
    mergeProgrammes(await store.listProgrammes(uid, epgChannelId, from, to));

  app.get("/v1/epg/now-next", async (req, reply) => {
    const uid = uidOf(req);
    const t = now().toISOString();
    const far = new Date(now().getTime() + 24 * 3600_000).toISOString();
    const result: Record<string, { now?: unknown; next?: unknown }> = {};
    for (const c of await store.listChannels(uid)) {
      if (!c.epgChannelId) continue;
      const list = await programmesFor(uid, c.epgChannelId, t, far);
      result[c.id] = { now: list.find((p) => p.start <= t && p.stop > t), next: list.find((p) => p.start > t) };
    }
    return reply.send(result);
  });

  /** Time-window grid for the EPG view: `from`/`to` ISO timestamps, max 48h. */
  app.get("/v1/epg/grid", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const from = new Date(q.from ?? now().toISOString());
    const to = new Date(q.to ?? new Date(from.getTime() + 6 * 3600_000).toISOString());
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 48 * 3600_000) {
      return bad(reply, "invalid time window (max 48h)");
    }
    const uid = uidOf(req);
    const out: Record<string, unknown[]> = {};
    for (const c of await store.listChannels(uid)) {
      if (c.epgChannelId && !c.hidden) out[c.id] = await programmesFor(uid, c.epgChannelId, from.toISOString(), to.toISOString());
    }
    return out;
  });

  // ---- Free catalog (official / FAST / open directory) ----
  const filterOf = (q: Record<string, string | undefined>) => ({ q: q.q, country: q.country, category: q.category, language: q.language, arabic: q.arabic, europe: q.europe });

  app.get("/v1/catalog", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const f = filterOf(q);
    reply.header("x-total-count", await store.countCatalog(f));
    return store.searchCatalog({ ...f, limit: Number(q.limit) || undefined, offset: Number(q.offset) || undefined });
  });

  /** Downloadable M3U of the free catalog for the current filter (e.g. Arabic + Sports); open iptv-org data only. */
  app.get("/v1/catalog/export.m3u", async (req, reply) => {
    const rows = await store.exportCatalog(filterOf(req.query as Record<string, string | undefined>));
    const entries = rows.map((r) => ({ duration: -1, name: r.name, url: r.url, tvgLogo: r.logoUrl, groupTitle: r.group, attrs: (r.country ? { "tvg-country": r.country } : {}) as Record<string, string> }));
    return reply.header("content-type", "audio/x-mpegurl; charset=utf-8").header("x-total-count", rows.length).send(serializeM3U(entries));
  });

  app.get("/v1/catalog/facets", async () => store.catalogFacets());

  /** In-app catalog refresh for hosts without a worker (e.g. Vercel Hobby, where the cron has no manual "Run"). */
  const SYNC_LOCK = "iptv-org-lock";
  const SYNC_COOLDOWN_S = 600;
  app.get("/v1/catalog/sync", async () => {
    const last = await store.getSyncState("iptv-org");
    return {
      running: (await store.syncAgeSeconds(SYNC_LOCK)) !== undefined,
      channels: await store.countActiveDirectory(),
      lastSync: last ? { at: last.updatedAt, ...(JSON.parse(last.value) as object) } : null,
    };
  });
  app.post("/v1/catalog/sync", async (_req, reply) => {
    // A non-empty catalog is refreshed at most every 10 minutes, so open registration cannot be used to hammer iptv-org.
    const age = await store.syncAgeSeconds("iptv-org");
    if (age !== undefined && age < SYNC_COOLDOWN_S && (await store.countActiveDirectory()) > 0) {
      return bad(reply, `Catalog was refreshed ${Math.round(age / 60)} min ago; try again later`, 429);
    }
    if (!(await store.tryLock(SYNC_LOCK, 120))) return bad(reply, "A sync is already running", 409);
    try {
      return await syncIptvOrg(store, fetcher, catalogApi);
    } catch (e) {
      return bad(reply, `Sync failed: ${(e as Error).message}`, 502);
    } finally {
      await store.unlock(SYNC_LOCK);
    }
  });

  /**
   * Adds every catalog channel matching the filter to the caller's channels (best stream each), skipping ones
   * already present. Users can then rename, hide, reorder or delete them like any other channel.
   */
  app.post("/v1/catalog/import", async (req, reply) => {
    const b = body(req);
    const f = filterOf(Object.fromEntries(["q", "country", "category", "language", "arabic", "europe"].map((k) => [k, typeof b[k] === "string" ? (b[k] as string) : undefined])));
    const limit = Number.isInteger(b.limit) && (b.limit as number) > 0 ? Math.min(b.limit as number, 20_000) : 1_000;
    const result = await store.importCatalog(uidOf(req), { ...f, limit });
    return reply.code(201).send(result);
  });

  app.post("/v1/catalog/:id/add", async (req, reply) => {
    const uid = uidOf(req);
    const entry = await store.getCatalogChannel((req.params as { id: string }).id);
    if (!entry || entry.status !== "active") return bad(reply, "Not found", 404);
    const best = rankStreams(entry.streams)[0];
    if (!best) return bad(reply, "No stream available", 409);
    const row = await store.addChannel({
      userId: uid, name: entry.name, streamUrl: best.url, logoUrl: entry.logoUrl, group: entry.categories[0],
      country: entry.country, languages: entry.languages, categories: entry.categories,
      sortOrder: await store.nextSortOrder(uid), hidden: false,
    });
    return reply.code(201).send(row);
  });

  // ---- Premium directory: metadata only. No stream URLs; playback only via the user's own subscription. ----
  app.get("/v1/premium", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const f = filterOf(q);
    reply.header("x-total-count", await store.countPremium(f));
    return store.searchPremium({ ...f, limit: Number(q.limit) || undefined, offset: Number(q.offset) || undefined });
  });

  app.get("/v1/premium/facets", async () => store.premiumFacets());

  /** The user's own channels that look like this directory entry (e.g. from their Xtream subscription). */
  app.get("/v1/premium/:id/matches", async (req, reply) => {
    const uid = uidOf(req);
    const p = await store.getPremium((req.params as { id: string }).id);
    if (!p) return bad(reply, "Not found", 404);
    return matchOwnChannels(p.name, (await store.listChannels(uid)).filter((c) => !c.premiumId || c.premiumId === p.id));
  });

  /** Links one of the user's own channels to a directory entry: groups it under Premium and borrows the logo and guide match. */
  app.post("/v1/premium/:id/link", async (req, reply) => {
    const uid = uidOf(req);
    const p = await store.getPremium((req.params as { id: string }).id);
    const ch = typeof body(req).channelId === "string" ? await store.getChannel(uid, body(req).channelId as string) : undefined;
    if (!p || !ch) return bad(reply, "Not found", 404);
    const patch: Partial<Omit<UserChannel, "id" | "userId" | "sourceId">> = { premiumId: p.id };
    if (!ch.logoUrl && p.logoUrl) patch.logoUrl = p.logoUrl;
    if (!ch.epgChannelId) {
      const g = suggestEpgMappings([{ id: ch.id, name: p.name }], await store.listGuideChannels(uid), 0.85)[0];
      if (g) patch.epgChannelId = g.epgChannelId;
    }
    return store.updateChannel(uid, ch.id, patch);
  });

  app.delete("/v1/premium/link/:channelId", async (req, reply) => {
    const r = await store.updateChannel(uidOf(req), (req.params as { channelId: string }).channelId, { premiumId: undefined });
    return r ? reply.code(204).send() : bad(reply, "Not found", 404);
  });

  // ---- AI helpers (per-channel). Only channel names and guide text leave the server, and only when a model is configured. ----
  const aiGate = (uid: string, reply: FastifyReply) => {
    aiLimiter.fail(uid);
    const wait = aiLimiter.blockedFor(uid);
    if (wait) { reply.header("retry-after", wait).code(429).send({ error: "AI request limit reached, try again later" }); return false; }
    return true;
  };
  const langOf = (v: unknown): Lang => (v === "ar" ? "ar" : "en");

  app.post("/v1/ai/channels/:id/summary", async (req, reply) => {
    const uid = uidOf(req);
    if (!aiGate(uid, reply)) return;
    const ch = await store.getChannel(uid, (req.params as { id: string }).id);
    if (!ch) return bad(reply, "Not found", 404);
    const lang = langOf(body(req).lang);
    const t = now().toISOString();
    const list = ch.epgChannelId ? await programmesFor(uid, ch.epgChannelId, t, new Date(now().getTime() + 6 * 3600_000).toISOString()) : [];
    const cur = list.find((p) => p.start <= t && p.stop > t);
    const nxt = list.find((p) => p.start > t);
    const fallback = plainSummary(ch.name, cur, nxt, lang);
    if (!model || (!cur && !nxt)) return { summary: fallback, ai: false };
    try {
      const data = [cur && `NOW: ${clip(cur.title, 200)} — ${clip(cur.description, 500)}`, nxt && `NEXT: ${clip(nxt.title, 200)} (starts ${nxt.start})`].filter(Boolean).join("\n");
      return { summary: await model.complete(SUMMARY_SYSTEM(lang), `Channel: ${clip(ch.name, 100)}\n${data}`, 200), ai: true };
    } catch {
      return { summary: fallback, ai: false };
    }
  });

  app.post("/v1/ai/translate", async (req, reply) => {
    const uid = uidOf(req);
    const b = body(req);
    const text = str(b.text, 2000);
    if (!text) return bad(reply, "text is required (max 2000 characters)");
    if (!model) return bad(reply, "Translation needs an AI model: set ANTHROPIC_API_KEY on the server", 503);
    if (!aiGate(uid, reply)) return;
    try {
      return { text: await model.complete(TRANSLATE_SYSTEM(langOf(b.to)), text, 800), to: langOf(b.to) };
    } catch {
      return bad(reply, "Translation failed, try again later", 502);
    }
  });

  /** "More like this": nearest of the user's own channels by name/group/what's on (no model needed). */
  app.get("/v1/me/channels/:id/similar", async (req, reply) => {
    const uid = uidOf(req);
    const all = await store.listChannels(uid);
    const me = all.find((c) => c.id === (req.params as { id: string }).id);
    if (!me) return bad(reply, "Not found", 404);
    const text = (c: UserChannel) => `${c.name} ${c.group ?? ""}`;
    return nearest(embedder.embed(text(me)), all.filter((c) => c.id !== me.id && !c.hidden).map((c) => ({ id: c.id, vector: embedder.embed(text(c)) })), 8, 0.35);
  });

  // ---- Discovery: hybrid lexical + embedding search, recommendations (own channels only) ----
  const nowPlayingFor = async (uid: string, channels: UserChannel[]) => {
    const t = now().toISOString();
    const map: Record<string, { title: string; category?: string }> = {};
    for (const c of channels) {
      if (!c.epgChannelId) continue;
      const p = (await programmesFor(uid, c.epgChannelId, t, t)).find((x) => x.start <= t && x.stop > t);
      if (p) map[c.id] = { title: p.title, category: p.category };
    }
    return map;
  };

  app.get("/v1/search", async (req, reply) => {
    const q = str((req.query as Record<string, unknown>).q, 200);
    if (!q) return bad(reply, "q is required");
    const uid = uidOf(req);
    const channels = (await store.listChannels(uid)).filter((c) => !c.hidden);
    const playing = await nowPlayingFor(uid, channels);
    const lexical = searchChannels(q, channels, playing);
    const semantic = nearest(embedder.embed(q), channels.map((c) => ({ id: c.id, vector: embedder.embed(`${c.name} ${c.group ?? ""} ${playing[c.id]?.title ?? ""}`) })), 20, 0.3);
    const lexScore = new Map(lexical.map((h) => [h.id, h.score]));
    const ids = fuseRankings([lexical.map((h) => h.id), semantic.map((h) => h.id)]);
    return ids.map((id) => ({ id, score: lexScore.get(id) ?? 0 }));
  });

  app.post("/v1/me/watch-events", async (req, reply) => {
    const b = body(req);
    const uid = uidOf(req);
    if (typeof b.channelId !== "string" || !(await store.getChannel(uid, b.channelId))) return bad(reply, "unknown channel", 404);
    if (typeof b.seconds !== "number" || !(b.seconds > 0) || b.seconds > 86_400) return bad(reply, "invalid seconds");
    await store.addWatchEvent(uid, { channelId: b.channelId, seconds: b.seconds });
    return reply.code(204).send();
  });

  // Viewing history is the user's to delete.
  app.delete("/v1/me/watch-events", async (req, reply) => {
    await store.clearWatchEvents(uidOf(req));
    return reply.code(204).send();
  });

  app.get("/v1/recommendations", async (req) => {
    const uid = uidOf(req);
    return recommend(await store.listChannels(uid), await store.listWatchEvents(uid));
  });

  // Suggestions only; the client applies one via PATCH after the user approves.
  app.get("/v1/me/epg/suggestions", async (req) => {
    const uid = uidOf(req);
    return suggestEpgMappings(await store.listChannels(uid), await store.listGuideChannels(uid));
  });

  return app;
}
