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
}
export type NowNext = Record<string, { now?: Programme; next?: Programme }>;
export interface Suggestion {
  channelId: string;
  epgChannelId: string;
  confidence: number;
}

let token = "";
export const setToken = (t: string) => {
  token = t;
};

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  channels: () => call<Channel[]>("/v1/me/channels"),
  addChannel: (c: { name: string; streamUrl: string; group?: string }) =>
    call<Channel>("/v1/me/channels", { method: "POST", body: JSON.stringify(c) }),
  editChannel: (id: string, patch: Partial<Channel>) =>
    call<Channel>(`/v1/me/channels/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteChannel: (id: string) => call<void>(`/v1/me/channels/${id}`, { method: "DELETE" }),
  importM3U: (content: string) =>
    call<{ imported: number }>("/v1/me/playlists/import", {
      method: "POST",
      body: JSON.stringify({ content, ownershipAttested: true }),
    }),
  importEpg: (content: string) => call<{ programmes: number }>("/v1/me/epg/import", { method: "POST", body: JSON.stringify({ content }) }),
  nowNext: () => call<NowNext>("/v1/epg/now-next"),
  search: (q: string) => call<{ id: string; score: number }[]>(`/v1/search?q=${encodeURIComponent(q)}`),
  recommendations: () => call<{ id: string; score: number }[]>("/v1/recommendations"),
  watch: (channelId: string, seconds: number) =>
    call<void>("/v1/me/watch-events", { method: "POST", body: JSON.stringify({ channelId, seconds }) }),
  suggestions: () => call<Suggestion[]>("/v1/me/epg/suggestions"),
  exportM3U: async () => {
    const res = await fetch("/v1/me/playlists/export.m3u", { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    return res.text();
  },
};
