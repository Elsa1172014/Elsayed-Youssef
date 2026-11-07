// Read-only clients for the Entertainment Hub's metadata providers. Keys come from server env vars only and
// are never returned to the browser. Both hosts are fixed (no user-supplied URLs), so plain fetch is safe here.

export type Fetch = typeof fetch;

export interface TmdbTitle {
  tmdbId: number;
  kind: "movie" | "tv";
  title: string;
  originalTitle?: string;
  overview?: string;
  posterPath?: string;
  backdropPath?: string;
  releaseDate?: string;
  voteAverage?: number;
  genreIds: number[];
  originalLanguage?: string;
}

export interface WatchProviders {
  link?: string;
  flatrate: { name: string; logo?: string }[];
  free: { name: string; logo?: string }[];
  ads: { name: string; logo?: string }[];
  rent: { name: string; logo?: string }[];
  buy: { name: string; logo?: string }[];
}

const TMDB = "https://api.themoviedb.org/3";

/** TMDB v3. Accepts the v4 "API Read Access Token" (Bearer, preferred) or a v3 API key. */
export class TmdbClient {
  constructor(private readonly credential: string, private readonly f: Fetch = fetch, private readonly language = "ar") {}

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const u = new URL(TMDB + path);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const bearer = this.credential.length > 40; // v4 tokens are long JWTs; v3 keys are 32 hex chars
    if (!bearer) u.searchParams.set("api_key", this.credential);
    const res = await this.f(u, { headers: { accept: "application/json", ...(bearer ? { authorization: `Bearer ${this.credential}` } : {}) }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`TMDB ${path} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private static map(x: Record<string, unknown>, kind?: "movie" | "tv"): TmdbTitle | undefined {
    const k = (kind ?? x.media_type) as string;
    if (k !== "movie" && k !== "tv") return undefined;
    const title = String((k === "movie" ? x.title : x.name) ?? "").trim();
    if (!title || typeof x.id !== "number") return undefined;
    return {
      tmdbId: x.id,
      kind: k,
      title,
      originalTitle: (k === "movie" ? x.original_title : x.original_name) as string | undefined,
      overview: (x.overview as string) || undefined,
      posterPath: (x.poster_path as string) || undefined,
      backdropPath: (x.backdrop_path as string) || undefined,
      releaseDate: ((k === "movie" ? x.release_date : x.first_air_date) as string) || undefined,
      voteAverage: typeof x.vote_average === "number" ? Math.round(x.vote_average * 10) / 10 : undefined,
      genreIds: Array.isArray(x.genre_ids) ? (x.genre_ids as number[]) : [],
      originalLanguage: x.original_language as string | undefined,
    };
  }

  /** Trending movies + series this week (adult titles excluded by TMDB for trending). */
  async trending(pages = 2): Promise<TmdbTitle[]> {
    const out: TmdbTitle[] = [];
    for (let p = 1; p <= pages; p++) {
      const r = await this.get<{ results?: Record<string, unknown>[] }>("/trending/all/week", { language: this.language, page: String(p) });
      for (const x of r.results ?? []) if (x.adult !== true) { const t = TmdbClient.map(x); if (t) out.push(t); }
    }
    return out;
  }

  async search(query: string): Promise<TmdbTitle[]> {
    const r = await this.get<{ results?: Record<string, unknown>[] }>("/search/multi", { query, language: this.language, include_adult: "false" });
    return (r.results ?? []).map((x) => TmdbClient.map(x)).filter((t): t is TmdbTitle => !!t);
  }

  async details(kind: "movie" | "tv", id: number): Promise<TmdbTitle | undefined> {
    const x = await this.get<Record<string, unknown>>(`/${kind}/${id}`, { language: this.language });
    const t = TmdbClient.map({ ...x, genre_ids: Array.isArray(x.genres) ? (x.genres as { id: number }[]).map((g) => g.id) : [] }, kind);
    return t;
  }

  async genres(): Promise<Record<number, string>> {
    const out: Record<number, string> = {};
    for (const k of ["movie", "tv"] as const) {
      const r = await this.get<{ genres?: { id: number; name: string }[] }>(`/genre/${k}/list`, { language: this.language });
      for (const g of r.genres ?? []) out[g.id] = g.name;
    }
    return out;
  }

  /** Where to watch, per region. Data by JustWatch — must be credited wherever it is shown. */
  async watchProviders(kind: "movie" | "tv", id: number, region: string): Promise<WatchProviders> {
    const r = await this.get<{ results?: Record<string, Record<string, unknown>> }>(`/${kind}/${id}/watch/providers`);
    const reg = r.results?.[region] ?? {};
    const list = (k: string) => (Array.isArray(reg[k]) ? (reg[k] as { provider_name: string; logo_path?: string }[]) : []).map((p) => ({ name: p.provider_name, logo: p.logo_path }));
    return { link: typeof reg.link === "string" ? reg.link : undefined, flatrate: list("flatrate"), free: list("free"), ads: list("ads"), rent: list("rent"), buy: list("buy") };
  }
}

export interface SportsEvent {
  idEvent: string;
  idLeague: string;
  league?: string;
  sport?: string;
  season?: string;
  homeTeam?: string;
  awayTeam?: string;
  homeBadge?: string;
  awayBadge?: string;
  eventTime?: string;
  venue?: string;
  status?: string;
  homeScore?: number;
  awayScore?: number;
  thumb?: string;
}

/** TheSportsDB v1 (key in the path; "123" is the shared free test key with reduced limits). */
export class SportsDbClient {
  constructor(private readonly key = "123", private readonly f: Fetch = fetch) {}

  get isFreeKey() { return this.key === "123" || this.key === "3"; }

  private async get<T>(endpoint: string, params: Record<string, string>): Promise<T> {
    const u = new URL(`https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(this.key)}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const res = await this.f(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`TheSportsDB ${endpoint} → HTTP ${res.status}`);
    const text = await res.text();
    try { return JSON.parse(text) as T; } catch { throw new Error(`TheSportsDB ${endpoint} returned non-JSON`); }
  }

  async league(id: string): Promise<{ id: string; name: string; sport?: string } | undefined> {
    const r = await this.get<{ leagues?: Record<string, string>[] | null }>("lookupleague.php", { id });
    const l = r.leagues?.[0];
    return l?.idLeague ? { id: l.idLeague, name: l.strLeague ?? id, sport: l.strSport } : undefined;
  }

  private static map(e: Record<string, string | null>): SportsEvent | undefined {
    if (!e.idEvent || !e.idLeague) return undefined;
    const num = (v: string | null | undefined) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
    const ts = e.strTimestamp ? (/[zZ]|[+-]\d\d:?\d\d$/.test(e.strTimestamp) ? e.strTimestamp : `${e.strTimestamp}Z`) : e.dateEvent ? `${e.dateEvent}T${e.strTime && /^\d\d:\d\d/.test(e.strTime) ? e.strTime.slice(0, 8) : "00:00:00"}Z` : undefined;
    return {
      idEvent: e.idEvent, idLeague: e.idLeague, league: e.strLeague ?? undefined, sport: e.strSport ?? undefined, season: e.strSeason ?? undefined,
      homeTeam: e.strHomeTeam ?? undefined, awayTeam: e.strAwayTeam ?? undefined, homeBadge: e.strHomeTeamBadge ?? undefined, awayBadge: e.strAwayTeamBadge ?? undefined,
      eventTime: ts && !Number.isNaN(Date.parse(ts)) ? new Date(ts).toISOString() : undefined, venue: e.strVenue ?? undefined, status: e.strStatus ?? undefined,
      homeScore: num(e.intHomeScore), awayScore: num(e.intAwayScore), thumb: e.strThumb ?? undefined,
    };
  }

  async next(idLeague: string): Promise<SportsEvent[]> {
    const r = await this.get<{ events?: Record<string, string | null>[] | null }>("eventsnextleague.php", { id: idLeague });
    return (r.events ?? []).map(SportsDbClient.map).filter((x): x is SportsEvent => !!x);
  }

  async past(idLeague: string): Promise<SportsEvent[]> {
    const r = await this.get<{ events?: Record<string, string | null>[] | null }>("eventspastleague.php", { id: idLeague });
    return (r.events ?? []).map(SportsDbClient.map).filter((x): x is SportsEvent => !!x);
  }
}
