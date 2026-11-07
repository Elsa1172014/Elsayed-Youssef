import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? undefined : String(v));

export interface McpTokenInfo { id: number; label: string; autoSync: boolean; createdAt?: string; lastUsedAt?: string }
export interface Favourite { channelId: string; name: string; note?: string; addedAt?: string }
export interface StreamCheck { channelId: string; ok: boolean; cause?: string; kind?: string; httpStatus?: number; latencyMs?: number; checkedAt?: string; trigger: "tool" | "cron" }

/** Global IPTV MCP persistence (Supabase schema "hub", server role only). Raw tokens are never stored. */
export class McpStore {
  constructor(readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  /** Issues a new token; the raw value is returned once and only its SHA-256 is kept. */
  async createToken(userId: string, label = "MCP"): Promise<{ token: string; info: McpTokenInfo }> {
    const token = `gim_${randomBytes(32).toString("base64url")}`;
    const r = await this.db.query("INSERT INTO hub.mcp_tokens (user_id, token_hash, label) VALUES ($1,$2,$3) RETURNING *", [userId, sha256(token), label.slice(0, 60)]);
    return { token, info: McpStore.info(r.rows[0]!) };
  }

  private static info(r: Record<string, unknown>): McpTokenInfo {
    return { id: Number(r.id), label: String(r.label), autoSync: !!r.auto_sync, createdAt: iso(r.created_at), lastUsedAt: iso(r.last_used_at) };
  }

  async listTokens(userId: string): Promise<McpTokenInfo[]> {
    const r = await this.db.query("SELECT * FROM hub.mcp_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC", [userId]);
    return r.rows.map((x) => McpStore.info(x));
  }

  async revokeToken(userId: string, id: number): Promise<boolean> {
    return (await this.db.query("UPDATE hub.mcp_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id", [id, userId])).rows.length > 0;
  }

  async setAutoSync(userId: string, id: number, on: boolean) {
    await this.db.query("UPDATE hub.mcp_tokens SET auto_sync = $3 WHERE id = $1 AND user_id = $2", [id, userId, on]);
  }

  /** Resolves a bearer token to its user (and stamps last use). Unknown, malformed or revoked tokens → undefined. */
  async userForToken(raw: string | undefined): Promise<string | undefined> {
    if (!raw || !/^gim_[A-Za-z0-9_-]{40,60}$/.test(raw)) return undefined;
    const r = await this.db.query<{ id: number; user_id: string }>("SELECT id, user_id FROM hub.mcp_tokens WHERE token_hash = $1 AND revoked_at IS NULL", [sha256(raw)]);
    const row = r.rows[0];
    if (!row) return undefined;
    await this.db.query("UPDATE hub.mcp_tokens SET last_used_at = $2 WHERE id = $1", [row.id, this.now().toISOString()]).catch(() => undefined);
    return row.user_id;
  }

  async autoSyncUsers(): Promise<string[]> {
    const r = await this.db.query<{ user_id: string }>("SELECT DISTINCT user_id FROM hub.mcp_tokens WHERE revoked_at IS NULL AND auto_sync ORDER BY user_id");
    return r.rows.map((x) => x.user_id);
  }

  // ---------- favourites ----------
  async favourites(userId: string): Promise<Favourite[]> {
    const r = await this.db.query("SELECT * FROM hub.mcp_favourites WHERE user_id = $1 ORDER BY added_at DESC", [userId]);
    return r.rows.map((x) => ({ channelId: String(x.channel_id), name: String(x.name), note: (x.note as string | null) ?? undefined, addedAt: iso(x.added_at) }));
  }

  async addFavourite(userId: string, f: { channelId: string; name: string; note?: string }) {
    await this.db.query(
      "INSERT INTO hub.mcp_favourites (user_id, channel_id, name, note) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, channel_id) DO UPDATE SET name = EXCLUDED.name, note = COALESCE(EXCLUDED.note, hub.mcp_favourites.note)",
      [userId, f.channelId, f.name.slice(0, 200), f.note?.slice(0, 300) ?? null],
    );
  }

  async removeFavourite(userId: string, channelId: string): Promise<boolean> {
    return (await this.db.query("DELETE FROM hub.mcp_favourites WHERE user_id = $1 AND channel_id = $2 RETURNING channel_id", [userId, channelId])).rows.length > 0;
  }

  // ---------- stream checks ----------
  async recordCheck(userId: string, c: Omit<StreamCheck, "checkedAt">) {
    await this.db.query(
      "INSERT INTO hub.stream_checks (user_id, channel_id, ok, cause, kind, http_status, latency_ms, trigger) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [userId, c.channelId, c.ok, c.cause ?? null, c.kind ?? null, c.httpStatus ?? null, c.latencyMs ?? null, c.trigger],
    );
  }

  async lastChecks(userId: string, channelIds: string[]): Promise<Record<string, StreamCheck>> {
    if (!channelIds.length) return {};
    const r = await this.db.query(
      "SELECT DISTINCT ON (channel_id) * FROM hub.stream_checks WHERE user_id = $1 AND channel_id = ANY($2::text[]) ORDER BY channel_id, checked_at DESC",
      [userId, channelIds],
    );
    return Object.fromEntries(r.rows.map((x) => [String(x.channel_id), {
      channelId: String(x.channel_id), ok: !!x.ok, cause: (x.cause as string | null) ?? undefined, kind: (x.kind as string | null) ?? undefined,
      httpStatus: x.http_status === null ? undefined : Number(x.http_status), latencyMs: x.latency_ms === null ? undefined : Number(x.latency_ms),
      checkedAt: iso(x.checked_at), trigger: x.trigger as "tool" | "cron",
    }]));
  }
}
