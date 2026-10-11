import { randomUUID } from "node:crypto";
import type { CatalogChannel, PremiumChannel, SourcedProgramme, WatchEvent, XmltvChannel } from "@receiver/core";
import type { Db } from "./db";

export type SourceType = "m3u_url" | "m3u_file" | "xtream" | "xmltv" | "tuner";

export interface UserSource {
  id: string;
  userId: string;
  type: SourceType;
  name: string;
  enabled: boolean;
  /** Public URL only; secrets live encrypted in a separate column and are never returned. */
  url?: string;
  ownershipAttestedAt: string;
  lastSyncAt?: string;
}

export interface UserChannel {
  id: string;
  userId: string;
  sourceId?: string;
  name: string;
  logoUrl?: string;
  group?: string;
  /** May contain {username}/{password} placeholders for Xtream channels; resolve via the stream endpoint. */
  streamUrl: string;
  epgChannelId?: string;
  /** Directory (Premium) entry this channel of the user's own subscription is linked to. */
  premiumId?: string;
  sortOrder: number;
  hidden: boolean;
}

export interface PremiumEntry extends PremiumChannel {
  status: "active" | "blocked" | "closed";
}

export interface CatalogStream {
  id: number;
  url: string;
  quality?: string;
  status: "unknown" | "ok" | "dead";
  latencyMs?: number;
}

export interface CatalogFilter {
  q?: string;
  country?: string;
  category?: string;
  language?: string;
}

export interface CatalogEntry extends Omit<CatalogChannel, "streams"> {
  status: "active" | "blocked" | "closed";
  streams: CatalogStream[];
}

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v ? new Date(v as string | Date).toISOString() : undefined);
const opt = <T>(v: T | null | undefined) => (v === null || v === undefined ? undefined : v);

const toSource = (r: Row): UserSource => ({
  id: r.id as string, userId: r.user_id as string, type: r.type as SourceType, name: r.name as string,
  enabled: r.enabled as boolean, url: opt(r.url as string | null), ownershipAttestedAt: iso(r.ownership_attested_at)!,
  lastSyncAt: iso(r.last_sync_at),
});
const toChannel = (r: Row): UserChannel => ({
  id: r.id as string, userId: r.user_id as string, sourceId: opt(r.source_id as string | null), name: r.name as string,
  logoUrl: opt(r.logo_url as string | null), group: opt(r.group_name as string | null), streamUrl: r.stream_url as string,
  epgChannelId: opt(r.epg_channel_id as string | null), premiumId: opt(r.premium_id as string | null), sortOrder: r.sort_order as number, hidden: r.hidden as boolean,
});

const CHANNEL_COLS: Record<string, string> = {
  name: "name", logoUrl: "logo_url", group: "group_name", streamUrl: "stream_url",
  epgChannelId: "epg_channel_id", premiumId: "premium_id", sortOrder: "sort_order", hidden: "hidden",
};
const SOURCE_COLS: Record<string, string> = { name: "name", enabled: "enabled", url: "url", lastSyncAt: "last_sync_at" };

export class Store {
  constructor(private db: Db) {}

  // ---- sources ----
  async listSources(userId: string) {
    return (await this.db.query("SELECT * FROM user_sources WHERE user_id=$1 ORDER BY name", [userId])).rows.map(toSource);
  }
  async getSource(userId: string, id: string) {
    const r = (await this.db.query("SELECT * FROM user_sources WHERE user_id=$1 AND id=$2", [userId, id])).rows[0];
    return r ? toSource(r) : undefined;
  }
  async getSourceSecret(userId: string, id: string): Promise<string | undefined> {
    const r = (await this.db.query<{ secret_enc: string | null }>("SELECT secret_enc FROM user_sources WHERE user_id=$1 AND id=$2", [userId, id])).rows[0];
    return opt(r?.secret_enc);
  }
  async addSource(s: Omit<UserSource, "id">, secretEnc?: string) {
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO user_sources (id,user_id,type,name,enabled,url,secret_enc,ownership_attested_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, s.userId, s.type, s.name, s.enabled, s.url ?? null, secretEnc ?? null, s.ownershipAttestedAt],
    );
    return (await this.getSource(s.userId, id))!;
  }
  async updateSource(userId: string, id: string, patch: Partial<Pick<UserSource, "name" | "enabled" | "url" | "lastSyncAt">>, secretEnc?: string) {
    const sets: string[] = [];
    const vals: unknown[] = [userId, id];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !SOURCE_COLS[k]) continue;
      vals.push(v);
      sets.push(`${SOURCE_COLS[k]}=$${vals.length}`);
    }
    if (secretEnc !== undefined) {
      vals.push(secretEnc);
      sets.push(`secret_enc=$${vals.length}`);
    }
    if (sets.length) await this.db.query(`UPDATE user_sources SET ${sets.join(",")} WHERE user_id=$1 AND id=$2`, vals);
    return this.getSource(userId, id);
  }
  async deleteSource(userId: string, id: string) {
    const r = await this.db.query("DELETE FROM user_sources WHERE user_id=$1 AND id=$2 RETURNING id", [userId, id]);
    return r.rows.length > 0;
  }

  // ---- channels ----
  async listChannels(userId: string) {
    return (await this.db.query("SELECT * FROM user_channels WHERE user_id=$1 ORDER BY sort_order, name", [userId])).rows.map(toChannel);
  }
  async getChannel(userId: string, id: string) {
    const r = (await this.db.query("SELECT * FROM user_channels WHERE user_id=$1 AND id=$2", [userId, id])).rows[0];
    return r ? toChannel(r) : undefined;
  }
  async addChannel(c: Omit<UserChannel, "id">) {
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO user_channels (id,user_id,source_id,name,logo_url,group_name,stream_url,epg_channel_id,sort_order,hidden) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [id, c.userId, c.sourceId ?? null, c.name, c.logoUrl ?? null, c.group ?? null, c.streamUrl, c.epgChannelId ?? null, c.sortOrder, c.hidden],
    );
    return (await this.getChannel(c.userId, id))!;
  }
  async updateChannel(userId: string, id: string, patch: Partial<Omit<UserChannel, "id" | "userId" | "sourceId">>) {
    const sets: string[] = [];
    const vals: unknown[] = [userId, id];
    for (const [k, col] of Object.entries(CHANNEL_COLS)) {
      if (!(k in patch)) continue;
      vals.push((patch as Row)[k] ?? null);
      sets.push(`${col}=$${vals.length}`);
    }
    if (sets.length) await this.db.query(`UPDATE user_channels SET ${sets.join(",")} WHERE user_id=$1 AND id=$2`, vals);
    return this.getChannel(userId, id);
  }
  async deleteChannel(userId: string, id: string) {
    return (await this.db.query("DELETE FROM user_channels WHERE user_id=$1 AND id=$2 RETURNING id", [userId, id])).rows.length > 0;
  }
  async nextSortOrder(userId: string) {
    const r = await this.db.query<{ n: number | string }>("SELECT COALESCE(MAX(sort_order)+1,0) AS n FROM user_channels WHERE user_id=$1", [userId]);
    return Number(r.rows[0]?.n ?? 0);
  }

  // ---- guide ----
  async replaceGuide(userId: string, sourceKey: string, priority: number, channels: XmltvChannel[], programmes: Omit<SourcedProgramme, "priority">[]) {
    await this.db.query("DELETE FROM programmes WHERE user_id=$1 AND source_key=$2", [userId, sourceKey]);
    await this.db.query("DELETE FROM guide_channels WHERE user_id=$1 AND source_key=$2", [userId, sourceKey]);
    for (const c of channels) {
      await this.db.query(
        "INSERT INTO guide_channels (user_id,source_key,epg_channel_id,display_names,icon) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [userId, sourceKey, c.id, JSON.stringify(c.displayNames), c.icon ?? null],
      );
    }
    for (const p of programmes) {
      await this.db.query(
        "INSERT INTO programmes (user_id,source_key,priority,epg_channel_id,start_utc,end_utc,title,description,category,lang) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [userId, sourceKey, priority, p.channelId, p.start, p.stop, p.title, p.description ?? null, p.category ?? null, p.lang ?? null],
      );
    }
  }
  async listGuideChannels(userId: string): Promise<XmltvChannel[]> {
    const rows = (await this.db.query("SELECT DISTINCT ON (epg_channel_id) epg_channel_id, display_names, icon FROM guide_channels WHERE user_id=$1 ORDER BY epg_channel_id", [userId])).rows;
    return rows.map((r) => ({ id: r.epg_channel_id as string, displayNames: r.display_names as string[], icon: opt(r.icon as string | null) }));
  }
  async listProgrammes(userId: string, epgChannelId: string, fromIso: string, toIso: string): Promise<SourcedProgramme[]> {
    const rows = (await this.db.query(
      "SELECT * FROM programmes WHERE user_id=$1 AND epg_channel_id=$2 AND end_utc>$3 AND start_utc<$4 ORDER BY start_utc",
      [userId, epgChannelId, fromIso, toIso],
    )).rows;
    return rows.map((r) => ({
      channelId: r.epg_channel_id as string, start: iso(r.start_utc)!, stop: iso(r.end_utc)!, title: r.title as string,
      description: opt(r.description as string | null), category: opt(r.category as string | null), lang: opt(r.lang as string | null),
      priority: r.priority as number,
    }));
  }

  // ---- watch history ----
  async addWatchEvent(userId: string, e: WatchEvent) {
    await this.db.query("INSERT INTO watch_events (user_id,channel_id,seconds) VALUES ($1,$2,$3)", [userId, e.channelId, Math.round(e.seconds)]);
  }
  async listWatchEvents(userId: string): Promise<WatchEvent[]> {
    return (await this.db.query("SELECT channel_id, seconds FROM watch_events WHERE user_id=$1", [userId])).rows.map((r) => ({ channelId: r.channel_id as string, seconds: r.seconds as number }));
  }
  async clearWatchEvents(userId: string) {
    await this.db.query("DELETE FROM watch_events WHERE user_id=$1", [userId]);
  }

  // ---- shared catalog ----
  /**
   * Upserts catalog channels and their streams in batches. Moderator-blocked channels stay blocked; channels
   * that were retired by an earlier sync come back to 'active' if the dataset lists them again.
   * Returns the sync stamp used for pruning.
   */
  async upsertCatalog(channels: CatalogChannel[], stamp = new Date().toISOString()): Promise<string> {
    const CH = 500;
    for (let i = 0; i < channels.length; i += CH) {
      const chunk = channels.slice(i, i + CH);
      const vals: unknown[] = [];
      const rows = chunk.map((c) => {
        const base = vals.length;
        vals.push(c.id, c.name, c.country ?? null, JSON.stringify(c.languages), JSON.stringify(c.categories), c.logoUrl ?? null, c.website ?? null, c.provenance, stamp);
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4}::jsonb,$${base + 5}::jsonb,$${base + 6},$${base + 7},$${base + 8},$${base + 9}::timestamptz)`;
      });
      await this.db.query(
        `INSERT INTO catalog_channels (id,name,country,languages,categories,logo_url,website,provenance,updated_at) VALUES ${rows.join(",")}
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,country=EXCLUDED.country,languages=EXCLUDED.languages,categories=EXCLUDED.categories,
           logo_url=EXCLUDED.logo_url,website=EXCLUDED.website,provenance=EXCLUDED.provenance,updated_at=EXCLUDED.updated_at,
           status=CASE WHEN catalog_channels.status='blocked' THEN 'blocked' ELSE 'active' END`,
        vals,
      );
    }
    const flat = channels.flatMap((c) => c.streams.map((s) => ({ id: c.id, url: s.url, quality: s.quality })));
    const ST = 1000;
    for (let i = 0; i < flat.length; i += ST) {
      const chunk = flat.slice(i, i + ST);
      const vals: unknown[] = [];
      const rows = chunk.map((x) => {
        const base = vals.length;
        vals.push(x.id, x.url, x.quality ?? null, stamp);
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4}::timestamptz)`;
      });
      await this.db.query(
        `INSERT INTO catalog_streams (channel_id,url,quality,seen_at) VALUES ${rows.join(",")}
         ON CONFLICT (channel_id,url_hash) DO UPDATE SET quality=EXCLUDED.quality, seen_at=EXCLUDED.seen_at`,
        vals,
      );
    }
    return stamp;
  }

  /**
   * Retires directory entries a completed sync did not see (channel closed/blocklisted/removed upstream).
   * Callers must skip this when the sync looks incomplete.
   */
  async pruneDirectory(stamp: string): Promise<{ closed: number; streamsRemoved: number }> {
    const closed = await this.db.query("UPDATE catalog_channels SET status='closed' WHERE provenance='directory' AND status='active' AND updated_at<$1::timestamptz RETURNING id", [stamp]);
    const removed = await this.db.query(
      "DELETE FROM catalog_streams s USING catalog_channels c WHERE s.channel_id=c.id AND c.provenance='directory' AND s.seen_at<$1::timestamptz RETURNING s.id", [stamp],
    );
    return { closed: closed.rows.length, streamsRemoved: removed.rows.length };
  }

  async countActiveDirectory(): Promise<number> {
    return Number((await this.db.query<{ n: string }>("SELECT count(*) AS n FROM catalog_channels WHERE provenance='directory' AND status='active'")).rows[0]?.n ?? 0);
  }

  async getSyncState(key: string): Promise<{ value: string; updatedAt: string } | undefined> {
    const r = (await this.db.query("SELECT value, updated_at FROM sync_state WHERE key=$1", [key])).rows[0];
    return r ? { value: r.value as string, updatedAt: iso(r.updated_at)! } : undefined;
  }
  async setSyncState(key: string, value: string) {
    await this.db.query("INSERT INTO sync_state (key,value,updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()", [key, value]);
  }

  private async attachStreams(rows: Row[]): Promise<CatalogEntry[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id as string);
    const streamRows = (await this.db.query("SELECT * FROM catalog_streams WHERE channel_id = ANY($1::text[]) ORDER BY id", [ids])).rows;
    const by = new Map<string, CatalogStream[]>();
    for (const s of streamRows) {
      const list = by.get(s.channel_id as string) ?? [];
      list.push({ id: Number(s.id), url: s.url as string, quality: opt(s.quality as string | null), status: s.status as CatalogStream["status"], latencyMs: opt(s.latency_ms as number | null) });
      by.set(s.channel_id as string, list);
    }
    return rows.map((r) => ({
      id: r.id as string, name: r.name as string, country: opt(r.country as string | null), languages: r.languages as string[],
      categories: r.categories as string[], logoUrl: opt(r.logo_url as string | null), website: opt(r.website as string | null),
      provenance: r.provenance as CatalogEntry["provenance"], status: r.status as CatalogEntry["status"], streams: by.get(r.id as string) ?? [],
    }));
  }

  private catalogWhere(opts: CatalogFilter) {
    const where = ["status='active'", "EXISTS (SELECT 1 FROM catalog_streams s WHERE s.channel_id=catalog_channels.id AND s.status<>'dead')"];
    const vals: unknown[] = [];
    if (opts.q) { vals.push(`%${opts.q.replace(/[\\%_]/g, "")}%`); where.push(`name ILIKE $${vals.length}`); }
    if (opts.country) { vals.push(opts.country.toUpperCase()); where.push(`country=$${vals.length}`); }
    if (opts.category) { vals.push(JSON.stringify([opts.category.toLowerCase()])); where.push(`categories @> $${vals.length}::jsonb`); }
    if (opts.language) { vals.push(JSON.stringify([opts.language.toLowerCase()])); where.push(`languages @> $${vals.length}::jsonb`); }
    return { sql: where.join(" AND "), vals };
  }

  async searchCatalog(opts: CatalogFilter & { limit?: number; offset?: number }) {
    const { sql, vals } = this.catalogWhere(opts);
    vals.push(Math.min(opts.limit ?? 50, 200), Math.max(opts.offset ?? 0, 0));
    const rows = (await this.db.query(`SELECT * FROM catalog_channels WHERE ${sql} ORDER BY name, id LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals)).rows;
    return this.attachStreams(rows);
  }

  async countCatalog(opts: CatalogFilter): Promise<number> {
    const { sql, vals } = this.catalogWhere(opts);
    return Number((await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM catalog_channels WHERE ${sql}`, vals)).rows[0]?.n ?? 0);
  }

  async catalogFacets() {
    const q = async (sql: string) => (await this.db.query<{ v: string; n: string }>(sql)).rows.map((r) => ({ value: r.v, count: Number(r.n) }));
    const active = "status='active' AND EXISTS (SELECT 1 FROM catalog_streams s WHERE s.channel_id=catalog_channels.id AND s.status<>'dead')";
    return {
      countries: await q(`SELECT country AS v, count(*) AS n FROM catalog_channels WHERE ${active} AND country IS NOT NULL GROUP BY country ORDER BY country`),
      categories: await q(`SELECT c AS v, count(*) AS n FROM catalog_channels, jsonb_array_elements_text(categories) c WHERE ${active} GROUP BY c ORDER BY c`),
      languages: await q(`SELECT l AS v, count(*) AS n FROM catalog_channels, jsonb_array_elements_text(languages) l WHERE ${active} GROUP BY l ORDER BY l`),
      total: await this.countCatalog({}),
    };
  }

  /** Channels matching a filter, each with its single best stream (healthy, HTTPS first, fastest). */
  async catalogForImport(opts: CatalogFilter & { limit: number }): Promise<{ id: string; name: string; logoUrl?: string; category?: string; streamUrl: string }[]> {
    const { sql, vals } = this.catalogWhere(opts);
    vals.push(opts.limit);
    const rows = (await this.db.query(
      `SELECT c.id, c.name, c.logo_url, c.categories->>0 AS category, best.url
         FROM (SELECT * FROM catalog_channels WHERE ${sql} ORDER BY name, id LIMIT $${vals.length}) c
         JOIN LATERAL (SELECT url FROM catalog_streams s WHERE s.channel_id=c.id AND s.status<>'dead'
                       ORDER BY (s.status='ok') DESC, (s.url LIKE 'https:%') DESC, s.latency_ms NULLS LAST, s.id LIMIT 1) best ON true
        ORDER BY c.name, c.id`, vals,
    )).rows;
    return rows.map((r) => ({ id: r.id as string, name: r.name as string, logoUrl: opt(r.logo_url as string | null), category: opt(r.category as string | null), streamUrl: r.url as string }));
  }

  async getCatalogChannel(id: string) {
    const rows = (await this.db.query("SELECT * FROM catalog_channels WHERE id=$1", [id])).rows;
    return (await this.attachStreams(rows))[0];
  }
  /** Moderation / takedown hook: blocked entries disappear from search and cannot be added. */
  async setCatalogStatus(id: string, status: CatalogEntry["status"]) {
    return (await this.db.query("UPDATE catalog_channels SET status=$2 WHERE id=$1 RETURNING id", [id, status])).rows.length > 0;
  }
  async listStreamsToCheck(limit: number): Promise<{ id: number; url: string }[]> {
    const rows = (await this.db.query(
      "SELECT s.id, s.url FROM catalog_streams s JOIN catalog_channels c ON c.id=s.channel_id WHERE c.status='active' ORDER BY s.last_checked_at NULLS FIRST, s.id LIMIT $1", [limit],
    )).rows;
    return rows.map((r) => ({ id: Number(r.id), url: r.url as string }));
  }
  async recordStreamHealth(id: number, status: "ok" | "dead", latencyMs?: number) {
    await this.db.query("UPDATE catalog_streams SET status=$2, latency_ms=$3, last_checked_at=now() WHERE id=$1", [id, status, latencyMs ?? null]);
  }

  // ---- premium directory (metadata only) ----
  async upsertPremium(channels: PremiumChannel[], stamp = new Date().toISOString()): Promise<string> {
    const CH = 500;
    for (let i = 0; i < channels.length; i += CH) {
      const chunk = channels.slice(i, i + CH);
      const vals: unknown[] = [];
      const rows = chunk.map((c) => {
        const b = vals.length;
        vals.push(c.id, c.name, c.country ?? null, JSON.stringify(c.languages), JSON.stringify(c.categories), c.logoUrl ?? null, c.website ?? null, stamp);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4}::jsonb,$${b + 5}::jsonb,$${b + 6},$${b + 7},$${b + 8}::timestamptz)`;
      });
      await this.db.query(
        `INSERT INTO premium_channels (id,name,country,languages,categories,logo_url,website,updated_at) VALUES ${rows.join(",")}
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,country=EXCLUDED.country,languages=EXCLUDED.languages,categories=EXCLUDED.categories,
           logo_url=EXCLUDED.logo_url,website=EXCLUDED.website,updated_at=EXCLUDED.updated_at,
           status=CASE WHEN premium_channels.status='blocked' THEN 'blocked' ELSE 'active' END`,
        vals,
      );
    }
    return stamp;
  }
  async prunePremium(stamp: string): Promise<number> {
    return (await this.db.query("UPDATE premium_channels SET status='closed' WHERE status='active' AND updated_at<$1::timestamptz RETURNING id", [stamp])).rows.length;
  }
  async countActivePremium(): Promise<number> {
    return Number((await this.db.query<{ n: string }>("SELECT count(*) AS n FROM premium_channels WHERE status='active'")).rows[0]?.n ?? 0);
  }
  private premiumWhere(opts: CatalogFilter) {
    const where = ["status='active'"];
    const vals: unknown[] = [];
    if (opts.q) { vals.push(`%${opts.q.replace(/[\\%_]/g, "")}%`); where.push(`name ILIKE $${vals.length}`); }
    if (opts.country) { vals.push(opts.country.toUpperCase()); where.push(`country=$${vals.length}`); }
    if (opts.category) { vals.push(JSON.stringify([opts.category.toLowerCase()])); where.push(`categories @> $${vals.length}::jsonb`); }
    if (opts.language) { vals.push(JSON.stringify([opts.language.toLowerCase()])); where.push(`languages @> $${vals.length}::jsonb`); }
    return { sql: where.join(" AND "), vals };
  }
  private toPremium = (r: Row): PremiumEntry => ({
    id: r.id as string, name: r.name as string, country: opt(r.country as string | null), languages: r.languages as string[],
    categories: r.categories as string[], logoUrl: opt(r.logo_url as string | null), website: opt(r.website as string | null), status: r.status as PremiumEntry["status"],
  });
  async searchPremium(opts: CatalogFilter & { limit?: number; offset?: number }) {
    const { sql, vals } = this.premiumWhere(opts);
    vals.push(Math.min(opts.limit ?? 50, 200), Math.max(opts.offset ?? 0, 0));
    return (await this.db.query(`SELECT * FROM premium_channels WHERE ${sql} ORDER BY name, id LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals)).rows.map(this.toPremium);
  }
  async countPremium(opts: CatalogFilter): Promise<number> {
    const { sql, vals } = this.premiumWhere(opts);
    return Number((await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM premium_channels WHERE ${sql}`, vals)).rows[0]?.n ?? 0);
  }
  async premiumFacets() {
    const q = async (sql: string) => (await this.db.query<{ v: string; n: string }>(sql)).rows.map((r) => ({ value: r.v, count: Number(r.n) }));
    return {
      countries: await q("SELECT country AS v, count(*) AS n FROM premium_channels WHERE status='active' AND country IS NOT NULL GROUP BY country ORDER BY country"),
      categories: await q("SELECT c AS v, count(*) AS n FROM premium_channels, jsonb_array_elements_text(categories) c WHERE status='active' GROUP BY c ORDER BY c"),
      languages: await q("SELECT l AS v, count(*) AS n FROM premium_channels, jsonb_array_elements_text(languages) l WHERE status='active' GROUP BY l ORDER BY l"),
      total: await this.countPremium({}),
    };
  }
  async getPremium(id: string) {
    const r = (await this.db.query("SELECT * FROM premium_channels WHERE id=$1 AND status='active'", [id])).rows[0];
    return r ? this.toPremium(r) : undefined;
  }
  async setPremiumStatus(id: string, status: PremiumEntry["status"]) {
    return (await this.db.query("UPDATE premium_channels SET status=$2 WHERE id=$1 RETURNING id", [id, status])).rows.length > 0;
  }
}
