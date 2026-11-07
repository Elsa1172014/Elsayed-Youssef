import type { Db } from "../db";
import type { SportsEvent, TmdbTitle, WatchProviders } from "./clients";

export type TitleSource = "tmdb" | "archive" | "own";
export interface TitleRow {
  id: number;
  source: TitleSource;
  tmdbId?: number;
  posterUrl?: string;
  releaseYear?: number;
  runtimeMin?: number;
  licenseUrl?: string;
  sourcePage?: string;
  kind: "movie" | "tv";
  title: string;
  originalTitle?: string;
  overview?: string;
  posterPath?: string;
  backdropPath?: string;
  releaseDate?: string;
  voteAverage?: number;
  genres: string[];
  providers: Partial<WatchProviders>;
  providersRegion?: string;
  trendingRank?: number;
  featured: boolean;
  licensedCount: number;
  updatedAt: string;
}

export interface LicensedSource {
  id: number;
  titleId: number;
  label: string;
  url: string;
  kind: "hls" | "dash" | "mp4";
  drmSystem?: "widevine" | "playready" | "fairplay" | "clearkey";
  licenseUrl?: string;
  rightsHolder: string;
  licenseRef: string;
  validUntil?: string;
  enabled: boolean;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? undefined : String(v));
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : undefined);
const und = <T>(v: T | null) => (v === null ? undefined : v);

/** Entertainment Hub persistence (Supabase schema "hub", reached only from the server). */
export class HubStore {
  constructor(readonly db: Db) {}

  // ---------- titles ----------
  async upsertTitle(t: TmdbTitle, genres: string[], trendingRank?: number): Promise<number> {
    const r = await this.db.query<{ id: number }>(
      `INSERT INTO hub.titles (tmdb_id, kind, title, original_title, overview, poster_path, backdrop_path, release_date, vote_average, genres, original_language, trending_rank, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12, now())
       ON CONFLICT (kind, tmdb_id) DO UPDATE SET title=EXCLUDED.title, original_title=EXCLUDED.original_title,
         overview=COALESCE(EXCLUDED.overview, hub.titles.overview), poster_path=EXCLUDED.poster_path, backdrop_path=EXCLUDED.backdrop_path,
         release_date=EXCLUDED.release_date, vote_average=EXCLUDED.vote_average, genres=EXCLUDED.genres, original_language=EXCLUDED.original_language,
         trending_rank=EXCLUDED.trending_rank, updated_at=now()
       RETURNING id`,
      [t.tmdbId, t.kind, t.title, t.originalTitle ?? null, t.overview ?? null, t.posterPath ?? null, t.backdropPath ?? null,
        t.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(t.releaseDate) ? t.releaseDate : null, t.voteAverage ?? null, JSON.stringify(genres), t.originalLanguage ?? null, trendingRank ?? null],
    );
    return Number(r.rows[0]!.id);
  }

  async clearTrending(keep: number[]) {
    await this.db.query("UPDATE hub.titles SET trending_rank = NULL WHERE trending_rank IS NOT NULL AND NOT (id = ANY($1::bigint[]))", [keep]);
  }

  async setProviders(id: number, providers: WatchProviders, region: string) {
    await this.db.query("UPDATE hub.titles SET providers=$2::jsonb, providers_region=$3 WHERE id=$1", [id, JSON.stringify(providers), region]);
  }

  /** TMDB terms: cached metadata must not be kept longer than 6 months. Titles with licensed sources are refreshed, not purged. */
  async purgeStaleTitles(): Promise<number> {
    const r = await this.db.query<{ n: number }>(
      "WITH d AS (DELETE FROM hub.titles t WHERE t.source = 'tmdb' AND t.updated_at < now() - interval '180 days' AND NOT EXISTS (SELECT 1 FROM hub.licensed_sources s WHERE s.title_id = t.id) RETURNING 1) SELECT count(*)::int AS n FROM d",
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  private static title(r: Record<string, unknown>): TitleRow {
    return {
      id: Number(r.id), source: (r.source as TitleSource) ?? "tmdb", tmdbId: r.tmdb_id === null || r.tmdb_id === undefined ? undefined : Number(r.tmdb_id),
      posterUrl: und(r.poster_url as string | null), releaseYear: r.release_year === null || r.release_year === undefined ? undefined : Number(r.release_year),
      runtimeMin: r.runtime_min === null || r.runtime_min === undefined ? undefined : Number(r.runtime_min), licenseUrl: und(r.license_url as string | null), sourcePage: und(r.source_page as string | null),
      kind: r.kind as "movie" | "tv", title: String(r.title), originalTitle: und(r.original_title as string | null),
      overview: und(r.overview as string | null), posterPath: und(r.poster_path as string | null), backdropPath: und(r.backdrop_path as string | null),
      releaseDate: day(r.release_date), voteAverage: r.vote_average === null ? undefined : Number(r.vote_average),
      genres: (typeof r.genres === "string" ? JSON.parse(r.genres) : r.genres) as string[], providers: (typeof r.providers === "string" ? JSON.parse(r.providers) : r.providers) as Partial<WatchProviders>,
      providersRegion: und(r.providers_region as string | null), trendingRank: r.trending_rank === null ? undefined : Number(r.trending_rank), featured: !!r.featured,
      licensedCount: Number(r.licensed_count ?? 0), updatedAt: iso(r.updated_at)!,
    };
  }

  async listTitles(f: { kind?: "movie" | "tv"; source?: TitleSource; q?: string; licensedOnly?: boolean; limit?: number; offset?: number }): Promise<{ items: TitleRow[]; total: number }> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (f.kind) { vals.push(f.kind); where.push(`t.kind = $${vals.length}`); }
    if (f.source) { vals.push(f.source); where.push(`t.source = $${vals.length}`); }
    if (f.q) { vals.push(`%${f.q.replace(/[%_\\]/g, (m) => "\\" + m)}%`); where.push(`(t.title ILIKE $${vals.length} OR t.original_title ILIKE $${vals.length})`); }
    if (f.licensedOnly) where.push("EXISTS (SELECT 1 FROM hub.licensed_sources s WHERE s.title_id = t.id AND s.enabled AND (s.valid_until IS NULL OR s.valid_until >= current_date))");
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM hub.titles t ${w}`, vals)).rows[0]?.n ?? 0);
    const limit = Math.min(Math.max(f.limit ?? 40, 1), 100);
    vals.push(limit, Math.max(f.offset ?? 0, 0));
    const rows = await this.db.query(
      `SELECT t.*, (SELECT count(*) FROM hub.licensed_sources s WHERE s.title_id = t.id AND s.enabled AND (s.valid_until IS NULL OR s.valid_until >= current_date))::int AS licensed_count
       FROM hub.titles t ${w} ORDER BY t.featured DESC, t.trending_rank ASC NULLS LAST, t.vote_average DESC NULLS LAST, t.id DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals,
    );
    return { items: rows.rows.map((r) => HubStore.title(r)), total };
  }

  async getTitle(id: number): Promise<TitleRow | undefined> {
    const r = await this.db.query("SELECT t.*, 0 AS licensed_count FROM hub.titles t WHERE t.id = $1", [id]);
    return r.rows[0] ? HubStore.title(r.rows[0]) : undefined;
  }

  async setFeatured(id: number, featured: boolean) {
    await this.db.query("UPDATE hub.titles SET featured=$2 WHERE id=$1", [id, featured]);
  }

  /** A film that is not on TMDB (open-licence archive film or the operator's own), with its playable source, in one step. */
  async upsertOpenTitle(t: {
    source: "archive" | "own"; externalId: string; kind: "movie" | "tv"; title: string; overview?: string; posterUrl?: string; releaseYear?: number; runtimeMin?: number;
    licenseUrl?: string; sourcePage?: string; genres?: string[]; play: { label: string; url: string; kind: "hls" | "dash" | "mp4"; rightsHolder: string; licenseRef: string; createdBy: string; drmSystem?: LicensedSource["drmSystem"]; licenseUrl?: string };
  }): Promise<number> {
    const r = await this.db.query<{ id: number }>(
      `INSERT INTO hub.titles (source, external_id, kind, title, overview, poster_url, release_year, runtime_min, license_url, source_page, genres, featured, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12, now())
       ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO UPDATE SET title=EXCLUDED.title, overview=EXCLUDED.overview, poster_url=EXCLUDED.poster_url,
         release_year=EXCLUDED.release_year, runtime_min=EXCLUDED.runtime_min, license_url=EXCLUDED.license_url, source_page=EXCLUDED.source_page, updated_at=now()
       RETURNING id`,
      [t.source, t.externalId, t.kind, t.title, t.overview ?? null, t.posterUrl ?? null, t.releaseYear ?? null, t.runtimeMin ?? null, t.licenseUrl ?? null, t.sourcePage ?? null,
        JSON.stringify(t.genres ?? []), t.source === "own"],
    );
    const id = Number(r.rows[0]!.id);
    if (!(await this.sourcesFor(id, false)).some((s) => s.url === t.play.url)) await this.addSource({ titleId: id, ...t.play });
    return id;
  }

  async existingExternal(source: TitleSource, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const r = await this.db.query<{ external_id: string }>("SELECT external_id FROM hub.titles WHERE source = $1 AND external_id = ANY($2::text[])", [source, ids]);
    return new Set(r.rows.map((x) => x.external_id));
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    const r = await this.db.query<{ value: unknown }>("SELECT value FROM hub.settings WHERE key = $1", [key]);
    const v = r.rows[0]?.value;
    return (typeof v === "string" ? JSON.parse(v) : v) as T | undefined;
  }

  async setSetting(key: string, value: unknown) {
    await this.db.query("INSERT INTO hub.settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [key, JSON.stringify(value)]);
  }

  async deleteTitle(id: number): Promise<boolean> {
    return (await this.db.query("DELETE FROM hub.titles WHERE id = $1 RETURNING id", [id])).rows.length > 0;
  }

  // ---------- licensed sources ----------
  private static source(r: Record<string, unknown>): LicensedSource {
    return {
      id: Number(r.id), titleId: Number(r.title_id), label: String(r.label), url: String(r.url), kind: r.kind as LicensedSource["kind"],
      drmSystem: und(r.drm_system as LicensedSource["drmSystem"] | null), licenseUrl: und(r.license_url as string | null),
      rightsHolder: String(r.rights_holder), licenseRef: String(r.license_ref), validUntil: day(r.valid_until), enabled: !!r.enabled,
    };
  }

  async sourcesFor(titleId: number, playableOnly: boolean): Promise<LicensedSource[]> {
    const r = await this.db.query(
      `SELECT * FROM hub.licensed_sources WHERE title_id = $1 ${playableOnly ? "AND enabled AND (valid_until IS NULL OR valid_until >= current_date)" : ""} ORDER BY id`,
      [titleId],
    );
    return r.rows.map((x) => HubStore.source(x));
  }

  async addSource(s: Omit<LicensedSource, "id" | "enabled"> & { createdBy: string }): Promise<LicensedSource> {
    const r = await this.db.query(
      `INSERT INTO hub.licensed_sources (title_id, label, url, kind, drm_system, license_url, rights_holder, license_ref, valid_until, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [s.titleId, s.label, s.url, s.kind, s.drmSystem ?? null, s.licenseUrl ?? null, s.rightsHolder, s.licenseRef, s.validUntil ?? null, s.createdBy],
    );
    return HubStore.source(r.rows[0]!);
  }

  async setSourceEnabled(id: number, enabled: boolean) {
    await this.db.query("UPDATE hub.licensed_sources SET enabled=$2 WHERE id=$1", [id, enabled]);
  }

  async deleteSource(id: number): Promise<boolean> {
    return (await this.db.query("DELETE FROM hub.licensed_sources WHERE id=$1 RETURNING id", [id])).rows.length > 0;
  }

  // ---------- sports ----------
  async leagues(enabledOnly = false) {
    const r = await this.db.query<{ id_league: string; name: string; sport: string | null; enabled: boolean }>(
      `SELECT id_league, name, sport, enabled FROM hub.sports_leagues ${enabledOnly ? "WHERE enabled" : ""} ORDER BY name`,
    );
    return r.rows.map((x) => ({ id: x.id_league, name: x.name, sport: und(x.sport), enabled: !!x.enabled }));
  }

  async addLeague(l: { id: string; name: string; sport?: string }) {
    await this.db.query("INSERT INTO hub.sports_leagues (id_league, name, sport) VALUES ($1,$2,$3) ON CONFLICT (id_league) DO UPDATE SET name=EXCLUDED.name, sport=EXCLUDED.sport, enabled=true", [l.id, l.name, l.sport ?? null]);
  }

  async removeLeague(id: string) {
    await this.db.query("DELETE FROM hub.sports_leagues WHERE id_league=$1", [id]);
  }

  async upsertEvents(events: SportsEvent[]) {
    for (const e of events) {
      await this.db.query(
        `INSERT INTO hub.sports_events (id_event, id_league, league, sport, season, home_team, away_team, home_badge, away_badge, event_time, venue, status, home_score, away_score, thumb, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
         ON CONFLICT (id_event) DO UPDATE SET event_time=EXCLUDED.event_time, venue=EXCLUDED.venue, status=EXCLUDED.status, home_score=EXCLUDED.home_score,
           away_score=EXCLUDED.away_score, thumb=COALESCE(EXCLUDED.thumb, hub.sports_events.thumb), home_badge=COALESCE(EXCLUDED.home_badge, hub.sports_events.home_badge),
           away_badge=COALESCE(EXCLUDED.away_badge, hub.sports_events.away_badge), updated_at=now()`,
        [e.idEvent, e.idLeague, e.league ?? null, e.sport ?? null, e.season ?? null, e.homeTeam ?? null, e.awayTeam ?? null, e.homeBadge ?? null, e.awayBadge ?? null,
          e.eventTime ?? null, e.venue ?? null, e.status ?? null, e.homeScore ?? null, e.awayScore ?? null, e.thumb ?? null],
      );
    }
  }

  async purgeOldEvents() {
    await this.db.query("DELETE FROM hub.sports_events WHERE event_time < now() - interval '30 days'");
  }

  async events(f: { range: "upcoming" | "recent"; league?: string; limit?: number }) {
    const vals: unknown[] = [];
    const where = [f.range === "upcoming" ? "event_time >= now() - interval '3 hours'" : "event_time < now()"];
    if (f.league) { vals.push(f.league); where.push(`id_league = $${vals.length}`); }
    vals.push(Math.min(f.limit ?? 60, 200));
    const r = await this.db.query(
      `SELECT * FROM hub.sports_events WHERE ${where.join(" AND ")} ORDER BY event_time ${f.range === "upcoming" ? "ASC" : "DESC"} LIMIT $${vals.length}`,
      vals,
    );
    return r.rows.map((e) => ({
      idEvent: String(e.id_event), idLeague: String(e.id_league), league: und(e.league as string | null), sport: und(e.sport as string | null),
      homeTeam: und(e.home_team as string | null), awayTeam: und(e.away_team as string | null), homeBadge: und(e.home_badge as string | null), awayBadge: und(e.away_badge as string | null),
      eventTime: iso(e.event_time), venue: und(e.venue as string | null), status: und(e.status as string | null),
      homeScore: e.home_score === null ? undefined : Number(e.home_score), awayScore: e.away_score === null ? undefined : Number(e.away_score), thumb: und(e.thumb as string | null),
    }));
  }

  // ---------- jobs & errors ----------
  async startJob(job: string, trigger: "cron" | "manual"): Promise<number> {
    return Number((await this.db.query<{ id: number }>("INSERT INTO hub.job_runs (job, trigger) VALUES ($1,$2) RETURNING id", [job, trigger])).rows[0]!.id);
  }

  async finishJob(id: number, ok: boolean, stats: Record<string, unknown>, error?: string) {
    await this.db.query("UPDATE hub.job_runs SET finished_at=now(), ok=$2, stats=$3::jsonb, error=$4 WHERE id=$1", [id, ok, JSON.stringify(stats), error?.slice(0, 500) ?? null]);
  }

  async logError(source: string, message: string, context: Record<string, unknown> = {}, job?: string) {
    await this.db.query("INSERT INTO hub.error_log (job, source, message, context) VALUES ($1,$2,$3,$4::jsonb)", [job ?? null, source.slice(0, 80), message.slice(0, 500), JSON.stringify(context)]);
  }

  async jobs(limit = 30) {
    const r = await this.db.query("SELECT * FROM hub.job_runs ORDER BY started_at DESC LIMIT $1", [limit]);
    return r.rows.map((j) => ({ id: Number(j.id), job: String(j.job), trigger: String(j.trigger), startedAt: iso(j.started_at), finishedAt: iso(j.finished_at), ok: j.ok === null ? undefined : !!j.ok, stats: (typeof j.stats === "string" ? JSON.parse(j.stats) : j.stats) as Record<string, unknown>, error: und(j.error as string | null) }));
  }

  async errors(limit = 50) {
    const r = await this.db.query("SELECT * FROM hub.error_log ORDER BY at DESC LIMIT $1", [limit]);
    return r.rows.map((e) => ({ id: Number(e.id), at: iso(e.at), job: und(e.job as string | null), source: String(e.source), message: String(e.message), context: (typeof e.context === "string" ? JSON.parse(e.context) : e.context) as Record<string, unknown> }));
  }

  async counts() {
    const r = await this.db.query<{ titles: number; openFilms: number; licensed: number; leagues: number; events: number; errors24h: number }>(
      `SELECT (SELECT count(*) FROM hub.titles)::int AS titles, (SELECT count(*) FROM hub.titles WHERE source = 'archive')::int AS "openFilms", (SELECT count(*) FROM hub.licensed_sources WHERE enabled)::int AS licensed,
              (SELECT count(*) FROM hub.sports_leagues WHERE enabled)::int AS leagues, (SELECT count(*) FROM hub.sports_events WHERE event_time >= now())::int AS events,
              (SELECT count(*) FROM hub.error_log WHERE at > now() - interval '24 hours')::int AS errors24h`,
    );
    return r.rows[0]!;
  }

  async pruneLogs() {
    await this.db.query("SELECT hub.prune_logs()");
  }
}
