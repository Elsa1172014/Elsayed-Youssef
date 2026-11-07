// Channel-opening helpers: favourites, recently watched, alternative sources and external-player links.
// Everything here is per-device (localStorage) and read-only towards the server: nothing is deleted or modified.
import type { Channel } from "./api";

const FAV_KEY = "receiver.favs";
const RECENT_KEY = "receiver.recent";
const RECENT_MAX = 12;

const readList = (key: string): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const writeList = (key: string, list: string[]) => {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage unavailable (private mode / TV sandbox) */
  }
};

export const loadFavs = () => readList(FAV_KEY);
export const saveFavs = (ids: string[]) => writeList(FAV_KEY, ids);
export const loadRecent = () => readList(RECENT_KEY);
export const pushRecent = (id: string): string[] => {
  const next = [id, ...readList(RECENT_KEY).filter((x) => x !== id)].slice(0, RECENT_MAX);
  writeList(RECENT_KEY, next);
  return next;
};
export const clearRecent = () => writeList(RECENT_KEY, []);

/** Same name after Arabic/Latin normalisation, ignoring quality tags like "HD", "FHD", "1080p", "(backup)". */
export const channelKey = (name: string) =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "") // tashkeel + tatweel
    .replace(/[إأآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\b(uhd|fhd|hd|sd|4k|hevc|h265|\d{3,4}p)\b/g, "")
    .replace(/[([{][^)\]}]*[)\]}]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Other channels that look like the same station (different stream / source): candidates when one link is dead. */
export const alternativesFor = (c: Channel, all: Channel[]): Channel[] => {
  const k = channelKey(c.name);
  if (!k) return [];
  const seen = new Set([(c.streamUrl ?? "").trim()]);
  return all.filter((x) => {
    if (x.id === c.id || x.hidden || channelKey(x.name) !== k) return false;
    const u = (x.streamUrl ?? "").trim();
    if (seen.has(u)) return false; // identical link is not an alternative
    seen.add(u);
    return true;
  });
};

/** Links that hand the stream to an installed player app (useful when a browser cannot decode the codec). */
export const externalLinks = (url: string) => {
  const noScheme = url.replace(/^[a-z]+:\/\//i, "");
  const scheme = (url.match(/^([a-z]+):\/\//i)?.[1] ?? "http").toLowerCase();
  return {
    vlc: `vlc://${url}`,
    android: `intent://${noScheme}#Intent;scheme=${scheme};type=video/*;end`,
    iosVlc: `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}`,
    infuse: `infuse://x-callback-url/play?url=${encodeURIComponent(url)}`,
  };
};

export const platform = (): "android" | "ios" | "desktop" => {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  return "desktop";
};

/** One-channel .m3u file so any desktop player (VLC, mpv, PotPlayer, Kodi) opens it with a double click. */
export const downloadM3u = (c: Channel) => {
  const body = `#EXTM3U\n#EXTINF:-1 tvg-id="${c.epgChannelId ?? ""}" group-title="${c.group ?? ""}",${c.name}\n${c.streamUrl}\n`;
  const href = URL.createObjectURL(new Blob([body], { type: "audio/x-mpegurl" }));
  const a = document.createElement("a");
  a.href = href;
  a.download = `${c.name.replace(/[\\/:*?"<>|]+/g, "_") || "channel"}.m3u`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
};
