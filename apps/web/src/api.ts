export interface Channel {
  id: string;
  sourceId?: string;
  premiumId?: string;
  name: string;
  streamUrl: string;
  logoUrl?: string;
  group?: string;
  country?: string;
  languages?: string[];
  categories?: string[];
  epgChannelId?: string;
  sortOrder: number;
  hidden: boolean;
}
export interface Programme {
  title: string;
  start: string;
  stop: string;
  category?: string;
}
export type NowNext = Record<string, { now?: Programme; next?: Programme }>;
export type Grid = Record<string, Programme[]>;
export interface Suggestion {
  channelId: string;
  epgChannelId: string;
  confidence: number;
}
export interface Source {
  id: string;
  type: "m3u_url" | "m3u_file" | "xtream" | "xmltv" | "tuner";
  name: string;
  enabled: boolean;
  url?: string;
  lastSyncAt?: string;
}
export interface CatalogEntry {
  id: string;
  name: string;
  country?: string;
  languages: string[];
  categories: string[];
  provenance: string;
  streams: { url: string; status: string }[];
}
export interface CatalogFilter {
  q?: string;
  country?: string;
  category?: string;
  language?: string;
  arabic?: string;
  europe?: string;
}
export interface PremiumEntry {
  id: string;
  name: string;
  country?: string;
  languages: string[];
  categories: string[];
  logoUrl?: string;
  website?: string;
}
export interface Facet {
  value: string;
  count: number;
}
export interface Facets {
  countries: Facet[];
  categories: Facet[];
  languages: Facet[];
  total: number;
}

let token = "";
let base = "";
let onUnauthorized: () => void = () => undefined;
export const setToken = (t: string) => {
  token = t;
};
/** Called when the server rejects the session (expired/revoked) so the UI can return to sign-in. */
export const setOnUnauthorized = (fn: () => void) => {
  onUnauthorized = fn;
};

// The session token lives in localStorage so TV and web sessions survive restarts. Any XSS could read it,
// so the app avoids injecting HTML and the API uses short-lived-by-revocation sessions (logout / password change revoke them).
const KEY = "receiver.token";
export const storedToken = (): string => {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
};
export const persistToken = (t: string) => {
  try {
    if (t) localStorage.setItem(KEY, t);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable (private mode / TV sandbox): session lasts until reload */
  }
};
/** API origin for packaged TV builds (Tizen/webOS), where relative URLs do not reach the backend. */
export const setBase = (b: string) => {
  base = b.replace(/\/$/, "");
};

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(base + path, {
    ...init,
    // Only declare JSON when there is a body: a body-less POST/DELETE with a JSON content type is rejected by some servers.
    headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), authorization: `Bearer ${token}`, ...init.headers },
  });
  if (res.status === 401 && token && !path.startsWith("/v1/auth/")) onUnauthorized();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; stage?: string; detail?: string };
    // Server start-up problems (503) carry a redacted hint such as "database: ECONNREFUSED"; show it so the owner can fix the setup.
    throw new Error(body.stage && body.detail ? `${body.error} (${body.stage}: ${body.detail})` : (body.error ?? `Request failed (${res.status})`));
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  register: (username: string, password: string) => call<{ token: string }>("/v1/auth/register", json("POST", { username, password })),
  login: (username: string, password: string) => call<{ token: string }>("/v1/auth/login", json("POST", { username, password })),
  logout: () => call<void>("/v1/auth/logout", json("POST")),
  me: () => call<{ id: string; username: string }>("/v1/me"),
  changePassword: (currentPassword: string, newPassword: string) => call<void>("/v1/auth/password", json("POST", { currentPassword, newPassword })),
  deleteAccount: (password: string) => call<void>("/v1/me", json("DELETE", { password })),
/** Loads every channel in pages of 2000 (a 10k list in one response can exceed serverless size/time limits). */
  channels: async (onPage?: (soFar: Channel[]) => void) => {
    const all: Channel[] = [];
    for (;;) {
      const page = await call<Channel[]>(`/v1/me/channels?limit=2000&offset=${all.length}`);
      all.push(...page);
      onPage?.([...all]);
      if (page.length < 2000) return all;
    }
  },
  addChannel: (c: { name: string; streamUrl: string; group?: string }) => call<Channel>("/v1/me/channels", json("POST", c)),
  editChannel: (id: string, patch: Partial<Channel>) => call<Channel>(`/v1/me/channels/${id}`, json("PATCH", patch)),
  deleteChannel: (id: string) => call<void>(`/v1/me/channels/${id}`, json("DELETE")),
  /** `url` is the stream's own address; `proxy` is a signed same-origin relay for streams browsers cannot reach directly. */
  stream: async (id: string) => {
    const r = await call<{ url: string; proxy: string }>(`/v1/me/channels/${id}/stream`);
    return { url: r.url, proxy: base + r.proxy };
  },
  importM3U: (content: string) => call<{ imported: number }>("/v1/me/playlists/import", json("POST", { content, ownershipAttested: true })),
  importEpg: (content: string) => call<{ programmes: number }>("/v1/me/epg/import", json("POST", { content })),
  exportM3U: async () => {
    const res = await fetch(`${base}/v1/me/playlists/export.m3u`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    return res.text();
  },
  nowNext: () => call<NowNext>("/v1/epg/now-next"),
  grid: (from: Date, to: Date) => call<Grid>(`/v1/epg/grid?from=${from.toISOString()}&to=${to.toISOString()}`),
  search: (q: string) => call<{ id: string; score: number }[]>(`/v1/search?q=${encodeURIComponent(q)}`),
  recommendations: () => call<{ id: string; score: number }[]>("/v1/recommendations"),
  watch: (channelId: string, seconds: number) => call<void>("/v1/me/watch-events", json("POST", { channelId, seconds })),
  suggestions: () => call<Suggestion[]>("/v1/me/epg/suggestions"),
  sources: () => call<Source[]>("/v1/me/sources"),
  addSource: (s: { name: string; type: Source["type"]; url?: string; username?: string; password?: string }) =>
    call<Source>("/v1/me/sources", json("POST", { ...s, ownershipAttested: true })),
  editSource: (id: string, patch: { name?: string; enabled?: boolean }) => call<Source>(`/v1/me/sources/${id}`, json("PATCH", patch)),
  deleteSource: (id: string) => call<void>(`/v1/me/sources/${id}`, json("DELETE")),
  syncSource: (id: string) => call<{ added?: number; programmes?: number }>(`/v1/me/sources/${id}/sync`, json("POST")),
  catalog: async (f: CatalogFilter, offset = 0) => {
    const qs = new URLSearchParams({ offset: String(offset), limit: "50" });
    for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v);
    const res = await fetch(`${base}/v1/catalog?${qs}`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) onUnauthorized();
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return { items: (await res.json()) as CatalogEntry[], total: Number(res.headers.get("x-total-count") ?? 0) };
  },
  facets: () => call<Facets>("/v1/catalog/facets"),
  stats: () => call<{ channels: number; sources: number; catalog: number }>("/v1/me/stats"),
  syncStatus: () => call<{ running: boolean; channels: number; lastSync: { at: string; channels: number; streams: number; premium: number } | null }>("/v1/catalog/sync"),
  syncNow: () => call<{ channels: number; streams: number; premium: number }>("/v1/catalog/sync", json("POST")),
  premium: async (f: CatalogFilter, offset = 0) => {
    const qs = new URLSearchParams({ offset: String(offset), limit: "50" });
    for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v);
    const res = await fetch(`${base}/v1/premium?${qs}`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) onUnauthorized();
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return { items: (await res.json()) as PremiumEntry[], total: Number(res.headers.get("x-total-count") ?? 0) };
  },
  premiumFacets: () => call<Facets>("/v1/premium/facets"),
  premiumMatches: (id: string) => call<{ channelId: string; confidence: number }[]>(`/v1/premium/${encodeURIComponent(id)}/matches`),
  premiumLink: (id: string, channelId: string) => call<Channel>(`/v1/premium/${encodeURIComponent(id)}/link`, json("POST", { channelId })),
  premiumUnlink: (channelId: string) => call<void>(`/v1/premium/link/${channelId}`, json("DELETE")),
  aiSummary: (channelId: string, lang: string) => call<{ summary: string; ai: boolean }>(`/v1/ai/channels/${channelId}/summary`, json("POST", { lang })),
  aiTranslate: (text: string, to: string) => call<{ text: string }>("/v1/ai/translate", json("POST", { text, to })),
  similar: (channelId: string) => call<{ id: string; score: number }[]>(`/v1/me/channels/${channelId}/similar`),
  importCatalog: (f: CatalogFilter, limit = 20000) => call<{ added: number; skipped: number }>("/v1/catalog/import", json("POST", { ...f, limit })),
  addFromCatalog: (id: string) => call<Channel>(`/v1/catalog/${encodeURIComponent(id)}/add`, json("POST")),
  clearHistory: () => call<void>("/v1/me/watch-events", json("DELETE")),
};
