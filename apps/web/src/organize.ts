// Two-level organisation (activity → group) and duplicate collapsing for the Live list.
import type { Channel } from "./api";
import { channelKey } from "./tools";

const ACTIVITY_WORDS = new Set([
  "movies", "series", "classic", "entertainment", "comedy", "general", "lifestyle", "family", "culture", "cooking", "travel", "shop",
  "animation", "news", "weather", "business", "legislative", "auto", "outdoor", "relax", "science", "sports", "kids", "music",
  "documentary", "education", "religious", "undefined", "other", "",
]);

/**
 * The group a channel sits in inside its activity: the playlist's own group-title when it is meaningful
 * (e.g. "beIN Sports", "MBC", "Rotana"), otherwise its country, otherwise the language.
 */
export function subGroupOf(c: Channel, regionName: (code: string) => string): string {
  const g = (c.group ?? "").trim();
  const generic = ACTIVITY_WORDS.has(g.toLowerCase()) || /^iptv-org/i.test(g);
  if (g && !generic) return g.replace(/\s+/g, " ");
  if (c.country) return regionName(c.country);
  if (c.languages?.[0]) return c.languages[0].toUpperCase();
  return "—";
}

const score = (c: Channel, okIds?: Set<string>) =>
  (okIds?.has(c.id) ? 8 : 0) + (/^https:/i.test(c.streamUrl ?? "") ? 4 : 0) + (c.logoUrl ? 2 : 0) + (c.epgChannelId ? 1 : 0);

/**
 * Collapses duplicates for display only: identical links, and the same station under slightly different names
 * (quality tags, Arabic spelling variants). The best copy is shown; the others stay saved and remain available
 * as "other sources" in the player, so nothing is lost.
 */
export function collapseDuplicates(list: Channel[], okIds?: Set<string>): { shown: Channel[]; hidden: number } {
  const bestByKey = new Map<string, Channel>();
  const seenUrl = new Set<string>();
  for (const c of list) {
    const url = (c.streamUrl ?? "").trim().replace(/\/$/, "").toLowerCase();
    if (url && seenUrl.has(url)) continue;
    if (url) seenUrl.add(url);
    const k = channelKey(c.name) || `#${c.id}`;
    const cur = bestByKey.get(k);
    if (!cur || score(c, okIds) > score(cur, okIds)) bestByKey.set(k, c);
  }
  const keep = new Set([...bestByKey.values()].map((c) => c.id));
  const shown = list.filter((c) => keep.has(c.id));
  return { shown, hidden: list.length - shown.length };
}

/** Exact copies only (same stream link): safe to delete permanently, the first copy is kept. */
export function exactDuplicates(list: Channel[]): Channel[] {
  const seen = new Set<string>();
  const extra: Channel[] = [];
  for (const c of [...list].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const url = (c.streamUrl ?? "").trim().replace(/\/$/, "").toLowerCase();
    if (!url) continue;
    if (seen.has(url)) extra.push(c);
    else seen.add(url);
  }
  return extra;
}

/** Public playlists of channels that are officially free to watch (no paid or encrypted channels). */
export const LEGAL_PLAYLISTS = [
  { name: "Free-TV (قنوات مجانية رسمية)", url: "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8" },
];
