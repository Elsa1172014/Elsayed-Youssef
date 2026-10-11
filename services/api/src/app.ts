import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  assertPublicHttpUrl, parseM3U, parseXmltv, recommend, searchChannels, serializeM3U, suggestEpgMappings, type M3UEntry,
} from "@receiver/core";
import type { Authenticator } from "./auth";
import type { SourceType, Store, UserChannel } from "./store";

const SOURCE_TYPES: SourceType[] = ["m3u_url", "m3u_file", "xtream", "xmltv", "tuner"];
const MAX_PLAYLIST_BYTES = 10 * 1024 * 1024;

interface Deps {
  store: Store;
  authenticate: Authenticator;
  now?: () => Date;
}

function bad(reply: FastifyReply, message: string, code = 400) {
  return reply.code(code).send({ error: message });
}

function str(v: unknown, max = 500): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

export function buildApp({ store, authenticate, now = () => new Date() }: Deps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: MAX_PLAYLIST_BYTES });

  app.get("/healthz", async () => ({ ok: true }));

  app.addHook("preHandler", async (req, reply) => {
    if (req.url === "/healthz") return;
    const uid = authenticate(req);
    if (!uid) return bad(reply, "Unauthorized", 401);
    (req as FastifyRequest & { uid: string }).uid = uid;
  });
  const uidOf = (req: FastifyRequest) => (req as FastifyRequest & { uid: string }).uid;

  // ---- Sources (user-owned; legal attestation required) ----
  app.get("/v1/me/sources", async (req) => store.listSources(uidOf(req)));

  app.post("/v1/me/sources", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = str(b.name, 120);
    if (!name) return bad(reply, "name is required");
    if (!SOURCE_TYPES.includes(b.type as SourceType)) return bad(reply, "invalid type");
    if (b.ownershipAttested !== true) {
      return bad(reply, "You must attest that you own or are entitled to use this source");
    }
    let url: string | undefined;
    if (b.url !== undefined) {
      try {
        url = assertPublicHttpUrl(String(b.url)).toString();
      } catch (e) {
        return bad(reply, (e as Error).message);
      }
    }
    const row = store.addSource({
      userId: uidOf(req), type: b.type as SourceType, name, enabled: true, url, ownershipAttestedAt: now().toISOString(),
    });
    return reply.code(201).send(row);
  });

  app.patch("/v1/me/sources/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
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
    const row = store.updateSource(uidOf(req), id, patch);
    return row ?? bad(reply, "Not found", 404);
  });

  app.delete("/v1/me/sources/:id", async (req, reply) => {
    const ok = store.deleteSource(uidOf(req), (req.params as { id: string }).id);
    return ok ? reply.code(204).send() : bad(reply, "Not found", 404);
  });

  // ---- Channels (full user editing control) ----
  app.get("/v1/me/channels", async (req) => store.listChannels(uidOf(req)));

  app.post("/v1/me/channels", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = str(b.name, 200);
    if (!name) return bad(reply, "name is required");
    let streamUrl: string;
    try {
      streamUrl = assertPublicHttpUrl(String(b.streamUrl)).toString();
    } catch (e) {
      return bad(reply, (e as Error).message);
    }
    const uid = uidOf(req);
    const row = store.addChannel({
      userId: uid, name, streamUrl, logoUrl: str(b.logoUrl, 1000), group: str(b.group, 120),
      epgChannelId: str(b.epgChannelId, 200), sortOrder: store.listChannels(uid).length, hidden: false,
    });
    return reply.code(201).send(row);
  });

  app.patch("/v1/me/channels/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<Omit<UserChannel, "id" | "userId">> = {};
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
    return store.updateChannel(uidOf(req), id, patch) ?? bad(reply, "Not found", 404);
  });

  app.delete("/v1/me/channels/:id", async (req, reply) => {
    return store.deleteChannel(uidOf(req), (req.params as { id: string }).id)
      ? reply.code(204).send()
      : bad(reply, "Not found", 404);
  });

  // ---- Playlist import / export (M3U text supplied by the user) ----
  app.post("/v1/me/playlists/import", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const content = typeof b.content === "string" ? b.content : undefined;
    if (!content) return bad(reply, "content (M3U text) is required");
    if (b.ownershipAttested !== true) {
      return bad(reply, "You must attest that you own or are entitled to use this playlist");
    }
    const uid = uidOf(req);
    const parsed = parseM3U(content);
    const source = store.addSource({
      userId: uid, type: "m3u_file", name: str(b.name, 120) ?? "Imported playlist", enabled: true,
      ownershipAttestedAt: now().toISOString(),
    });
    let order = store.listChannels(uid).length;
    for (const e of parsed.entries) {
      store.addChannel({
        userId: uid, sourceId: source.id, name: e.name, streamUrl: e.url, logoUrl: e.tvgLogo,
        group: e.groupTitle, epgChannelId: e.tvgId, sortOrder: order++, hidden: false,
      });
    }
    return reply.code(201).send({ sourceId: source.id, imported: parsed.entries.length, warnings: parsed.warnings, epgUrls: parsed.epgUrls });
  });

  app.get("/v1/me/playlists/export.m3u", async (req, reply) => {
    const entries: M3UEntry[] = store.listChannels(uidOf(req)).filter((c) => !c.hidden).map((c) => ({
      name: c.name, url: c.streamUrl, duration: -1, tvgId: c.epgChannelId, tvgLogo: c.logoUrl, groupTitle: c.group, attrs: {},
    }));
    return reply.header("content-type", "audio/x-mpegurl; charset=utf-8").send(serializeM3U(entries));
  });

  // ---- EPG (user-supplied XMLTV) ----
  app.post("/v1/me/epg/import", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.content !== "string" || !b.content) return bad(reply, "content (XMLTV text) is required");
    const r = parseXmltv(b.content);
    store.replaceProgrammes(uidOf(req), r.programmes, r.channels);
    return reply.code(201).send({ channels: r.channels.length, programmes: r.programmes.length, warnings: r.warnings.length });
  });

  app.get("/v1/epg/now-next", async (req, reply) => {
    const uid = uidOf(req);
    const t = now().toISOString();
    const far = new Date(now().getTime() + 24 * 3600_000).toISOString();
    const result: Record<string, { now?: unknown; next?: unknown }> = {};
    for (const c of store.listChannels(uid)) {
      if (!c.epgChannelId) continue;
      const list = store.listProgrammes(uid, c.epgChannelId, t, far);
      result[c.id] = { now: list.find((p) => p.start <= t && p.stop > t), next: list.find((p) => p.start > t) };
    }
    return reply.send(result);
  });

  // ---- AI-assisted discovery (runs only over the caller's own channels) ----
  const nowPlayingFor = (uid: string) => {
    const t = now().toISOString();
    const map: Record<string, { title: string; category?: string }> = {};
    for (const c of store.listChannels(uid)) {
      if (!c.epgChannelId) continue;
      const p = store.listProgrammes(uid, c.epgChannelId, t, t).find((x) => x.start <= t && x.stop > t);
      if (p) map[c.id] = { title: p.title, category: p.category };
    }
    return map;
  };

  app.get("/v1/search", async (req, reply) => {
    const q = str((req.query as Record<string, unknown>).q, 200);
    if (!q) return bad(reply, "q is required");
    const uid = uidOf(req);
    return searchChannels(q, store.listChannels(uid), nowPlayingFor(uid));
  });

  app.post("/v1/me/watch-events", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const uid = uidOf(req);
    if (typeof b.channelId !== "string" || !store.getChannel(uid, b.channelId)) return bad(reply, "unknown channel", 404);
    if (typeof b.seconds !== "number" || !(b.seconds > 0) || b.seconds > 86_400) return bad(reply, "invalid seconds");
    store.addWatchEvent(uid, { channelId: b.channelId, seconds: b.seconds });
    return reply.code(204).send();
  });

  // Viewing history is the user's to delete.
  app.delete("/v1/me/watch-events", async (req, reply) => {
    store.clearWatchEvents(uidOf(req));
    return reply.code(204).send();
  });

  app.get("/v1/recommendations", async (req) => {
    const uid = uidOf(req);
    return recommend(store.listChannels(uid), store.listWatchEvents(uid));
  });

  // Suggestions only; the client applies one via PATCH /v1/me/channels/:id after the user approves.
  app.get("/v1/me/epg/suggestions", async (req) => {
    const uid = uidOf(req);
    return suggestEpgMappings(store.listChannels(uid), store.listGuideChannels(uid));
  });

  return app;
}
