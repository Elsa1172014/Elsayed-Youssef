import { randomUUID } from "node:crypto";
import type { CatalogChannel, SourcedProgramme, WatchEvent, XmltvChannel } from "@receiver/core";
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
  sortOrder: number;
  hidden: boolean;
}

export interface CatalogStream {
  id: number;
  url: string;
  quality?: string;
  status: "unknown" | "ok" | "dead";
  latencyMs?: number;
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
  epgChannelId: opt(r.epg_channel_id as string | null), sortOrder: r.sort_order as number, hidden: r.hidden as boolean,
});

const CHANNEL_COLS: Record<string, string> = {
  name: "name", logoUrl: "logo_url", group: "group_name", streamUrl: "stream_url",
  epgChannelId: "epg_channel_id", sortOrder: "sort_order", hidden: "hidden",
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
  async upsertCatalog(channels: CatalogChannel[]) {
    for (const c of channels) {
      await this.db.query(
        `INSERT INTO catalog_channels (id,name,country,languages,categories,logo_url,website,provenance,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (id) DO UPDATE SET name=$2,country=$3,languages=$4,categories=$5,logo_url=$6,website=$7,provenance=$8,updated_at=now()`,
        [c.id, c.name, c.country ?? null, JSON.stringify(c.languages), JSON.stringify(c.categories), c.logoUrl ?? null, c.website ?? null, c.provenance],
      );
      for (const s of c.streams) {
        await this.db.query("INSERT INTO catalog_streams (channel_id,url,quality) VALUES ($1,$2,$3) ON CONFLICT (channel_id,url) DO UPDATE SET quality=$3", [c.id, s.url, s.quality ?? null]);
      }
    }
  }
  private async attachStreams(rows: Row[]): Promise<CatalogEntry[]> {
    const out: CatalogEntry[] = [];
    for (const r of rows) {
      const streams = (await this.db.query("SELECT * FROM catalog_streams WHERE channel_id=$1 ORDER BY id", [r.id])).rows.map((s) => ({
        id: Number(s.id), url: s.url as string, quality: opt(s.quality as string | null), status: s.status as CatalogStream["status"],
        latencyMs: opt(s.latency_ms as number | null),
      }));
      out.push({
        id: r.id as string, name: r.name as string, country: opt(r.country as string | null), languages: r.languages as string[],
        categories: r.categories as string[], logoUrl: opt(r.logo_url as string | null), website: opt(r.website as string | null),
        provenance: r.provenance as CatalogEntry["provenance"], status: r.status as CatalogEntry["status"], streams,
      });
    }
    return out;
  }
  async searchCatalog(opts: { q?: string; country?: string; category?: string; limit?: number }) {
    const where = ["status='active'"];
    const vals: unknown[] = [];
    if (opts.q) { vals.push(`%${opts.q.replace(/[%_]/g, "")}%`); where.push(`name ILIKE $${vals.length}`); }
    if (opts.country) { vals.push(opts.country.toUpperCase()); where.push(`country=$${vals.length}`); }
    if (opts.category) { vals.push(JSON.stringify([opts.category.toLowerCase()])); where.push(`categories @> $${vals.length}::jsonb`); }
    vals.push(Math.min(opts.limit ?? 50, 200));
    const rows = (await this.db.query(`SELECT * FROM catalog_channels WHERE ${where.join(" AND ")} ORDER BY name LIMIT $${vals.length}`, vals)).rows;
    return this.attachStreams(rows);
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
      "SELECT s.id, s.url FROM catalog_streams s JOIN catalog_channels c ON c.id=s.channel_id WHERE c.status='active' ORDER BY s.last_checked_at NULLS FIRST LIMIT $1", [limit],
    )).rows;
    return rows.map((r) => ({ id: Number(r.id), url: r.url as string }));
  }
  async recordStreamHealth(id: number, status: "ok" | "dead", latencyMs?: number) {
    await this.db.query("UPDATE catalog_streams SET status=$2, latency_ms=$3, last_checked_at=now() WHERE id=$1", [id, status, latencyMs ?? null]);
  }
}
