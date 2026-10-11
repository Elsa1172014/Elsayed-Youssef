export interface Channel {
  id: string;
  name: string;
  streamUrl: string;
  logoUrl?: string;
  group?: string;
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
  categories: string[];
  provenance: string;
  streams: { status: string }[];
}

let token = "";
let base = "";
export const setToken = (t: string) => {
  token = t;
};
/** API origin for packaged TV builds (Tizen/webOS), where relative URLs do not reach the backend. */
export const setBase = (b: string) => {
  base = b.replace(/\/$/, "");
};

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(base + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  channels: () => call<Channel[]>("/v1/me/channels"),
  addChannel: (c: { name: string; streamUrl: string; group?: string }) => call<Channel>("/v1/me/channels", json("POST", c)),
  editChannel: (id: string, patch: Partial<Channel>) => call<Channel>(`/v1/me/channels/${id}`, json("PATCH", patch)),
  deleteChannel: (id: string) => call<void>(`/v1/me/channels/${id}`, json("DELETE")),
  streamUrl: async (id: string) => (await call<{ url: string }>(`/v1/me/channels/${id}/stream`)).url,
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
  catalog: (q: string) => call<CatalogEntry[]>(`/v1/catalog?q=${encodeURIComponent(q)}`),
  addFromCatalog: (id: string) => call<Channel>(`/v1/catalog/${encodeURIComponent(id)}/add`, json("POST")),
  clearHistory: () => call<void>("/v1/me/watch-events", json("DELETE")),
};
