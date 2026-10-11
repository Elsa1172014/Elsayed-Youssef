import { tokenize } from "./text";

export interface WatchEvent {
  channelId: string;
  seconds: number;
}

export interface RecChannel {
  id: string;
  name: string;
  group?: string;
  hidden?: boolean;
}

/**
 * Content-based "On now for you": scores channels by overlap of group/name tokens with the
 * profile's watch-time-weighted taste, excluding hidden channels. Pure function; no data leaves the user.
 */
export function recommend(channels: RecChannel[], history: WatchEvent[], limit = 10): { id: string; score: number }[] {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const taste = new Map<string, number>();
  const watched = new Set<string>();
  for (const e of history) {
    const c = byId.get(e.channelId);
    if (!c || e.seconds <= 0) continue;
    watched.add(c.id);
    const feats = new Set([...(c.group ? [`g:${c.group.toLowerCase()}`] : []), ...tokenize(c.name).map((t) => `n:${t}`)]);
    for (const f of feats) taste.set(f, (taste.get(f) ?? 0) + Math.log1p(e.seconds / 60));
  }
  const out: { id: string; score: number }[] = [];
  for (const c of channels) {
    if (c.hidden || watched.has(c.id)) continue;
    const feats = [...(c.group ? [`g:${c.group.toLowerCase()}`] : []), ...tokenize(c.name).map((t) => `n:${t}`)];
    const score = feats.reduce((s, f) => s + (taste.get(f) ?? 0), 0);
    if (score > 0) out.push({ id: c.id, score: Math.round(score * 1000) / 1000 });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
