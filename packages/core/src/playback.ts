import { normalizeText } from "./text";

/**
 * Pure building blocks of the "AI Repair & Play" engine: stream-type detection, DRM/auth detection from the
 * stream's own metadata, failure classification, strict channel identity matching and a bounded retry policy.
 * Nothing here bypasses access controls: protected streams are reported as "needs login/subscription", never worked around.
 */

export type StreamKind = "hls" | "dash" | "mp4" | "ts" | "webm" | "audio" | "html" | "unknown";
export type DrmSystem = "widevine" | "playready" | "fairplay" | "clearkey";

export function detectStreamKind(url: string, contentType = "", body = ""): StreamKind {
  const ct = contentType.toLowerCase();
  const head = body.trimStart().slice(0, 512);
  if (/mpegurl/.test(ct) || head.startsWith("#EXTM3U")) return "hls";
  if (/dash\+xml/.test(ct) || /<MPD[\s>]/.test(head)) return "dash";
  if (/text\/html/.test(ct) || /^<!doctype html|^<html/i.test(head)) return "html";
  if (/video\/mp4/.test(ct)) return "mp4";
  if (/video\/(mp2t|mpeg|MP2T)/i.test(ct)) return "ts";
  if (/video\/webm/.test(ct)) return "webm";
  if (/^audio\//.test(ct)) return "audio";
  const path = url.split(/[?#]/)[0]!.toLowerCase();
  if (/\.m3u8?$/.test(path)) return "hls";
  if (/\.mpd$/.test(path)) return "dash";
  if (/\.(mp4|m4v|mov)$/.test(path)) return "mp4";
  if (/\.(ts|mts)$/.test(path)) return "ts";
  if (/\.webm$/.test(path)) return "webm";
  if (/\.(aac|mp3|m4a)$/.test(path)) return "audio";
  return "unknown";
}

/** Distinct CODECS="..." values declared in an HLS master playlist, or codecs attributes in a DASH manifest. */
export function declaredCodecs(manifest: string): string[] {
  const out = new Set<string>();
  for (const m of manifest.matchAll(/CODECS="([^"]+)"/g)) for (const c of m[1]!.split(",")) out.add(c.trim());
  for (const m of manifest.matchAll(/\bcodecs="([^"]+)"/g)) for (const c of m[1]!.split(",")) out.add(c.trim());
  return [...out].filter(Boolean);
}

export interface Protection {
  /** DRM key systems the stream asks for. Empty for clear and for plain AES-128 (which players decrypt with the key the provider serves). */
  drm: DrmSystem[];
  /** True when the media is encrypted in any way (including AES-128). */
  encrypted: boolean;
  /** License server URLs the manifest itself advertises (official, provider-published), if any. */
  licenseUrls: string[];
}

const SCHEME: Record<string, DrmSystem> = {
  "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed": "widevine",
  "9a04f079-9840-4286-ab92-e65be0885f95": "playready",
  "94ce86fb-07ff-4f43-adf8-8f3fd7e2c0bb": "fairplay",
  "1077efec-c0b2-4d02-ace3-3c1e52e2fb4b": "clearkey",
};

/** Reads DRM requirements from the manifest text (HLS EXT-X-KEY / EXT-X-SESSION-KEY, DASH ContentProtection). */
export function detectProtection(manifest: string): Protection {
  const drm = new Set<DrmSystem>();
  const licenseUrls = new Set<string>();
  let encrypted = false;
  for (const line of manifest.split(/\r?\n/)) {
    if (!/^#EXT-X-(SESSION-)?KEY:/.test(line)) continue;
    if (/METHOD=NONE/.test(line)) continue;
    encrypted = true;
    const fmt = /KEYFORMAT="([^"]+)"/.exec(line)?.[1]?.toLowerCase() ?? "";
    if (fmt.includes("streamingkeydelivery") || fmt.includes("fairplay")) drm.add("fairplay");
    else if (fmt.includes("edef8ba9")) drm.add("widevine");
    else if (fmt.includes("playready")) drm.add("playready");
    else if (/METHOD=SAMPLE-AES-CTR|METHOD=SAMPLE-AES/.test(line) && fmt && fmt !== "identity") drm.add("widevine");
    const la = /LICENSE-URL="([^"]+)"/i.exec(line)?.[1];
    if (la) licenseUrls.add(la);
  }
  for (const m of manifest.matchAll(/<ContentProtection\b[^>]*schemeIdUri="urn:uuid:([0-9a-f-]+)"/gi)) {
    encrypted = true;
    const sys = SCHEME[m[1]!.toLowerCase()];
    if (sys) drm.add(sys);
  }
  if (/<ContentProtection\b/i.test(manifest)) encrypted = true;
  for (const m of manifest.matchAll(/<(?:[\w]+:)?(?:Laurl|laurl)[^>]*>\s*(https?:\/\/[^<\s]+)\s*</g)) licenseUrls.add(m[1]!);
  return { drm: [...drm], encrypted, licenseUrls: [...licenseUrls] };
}

export type Cause =
  | "none"
  | "invalid_url"
  | "auth_required" // 401 or an invalid/expired login
  | "forbidden" // 403: blocked, geo-restricted or token expired
  | "geo_blocked" // 451
  | "gone" // 404/410
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "network"
  | "not_media" // 200 but an HTML page / empty / invalid playlist
  | "no_media_data" // manifest fine, but segments are missing or not media
  | "drm_protected"
  | "codec_unsupported"
  | "player_error"
  | "autoplay_blocked";

export function causeFromHttp(status: number): Cause {
  if (status >= 200 && status < 300) return "none";
  if (status === 401) return "auth_required";
  if (status === 403) return "forbidden";
  if (status === 451) return "geo_blocked";
  if (status === 404 || status === 410) return "gone";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "network";
}

/** Causes where trying the same URL again can help. Everything else needs an alternate source or the user. */
export const RETRYABLE: ReadonlySet<Cause> = new Set<Cause>(["timeout", "network", "rate_limited", "server_error", "player_error"]);
/** Causes the user must resolve (log in, subscribe, consent). They are surfaced, never bypassed. */
export const NEEDS_USER: ReadonlySet<Cause> = new Set<Cause>(["auth_required", "drm_protected", "autoplay_blocked"]);

/** True for TS sync byte, fMP4 boxes, or WebM/EBML: the first bytes of a real media segment. */
export function looksLikeMedia(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  if (bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47)) return true;
  const tag = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
  if (["ftyp", "moof", "styp", "sidx", "moov", "free", "mdat"].includes(tag)) return true;
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true;
  // ADTS AAC / MP3 audio
  if (bytes[0] === 0xff && (bytes[1]! & 0xf0) === 0xf0) return true;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; // ID3
  return false;
}

/** First media-segment (or init-map) URI of an HLS media playlist, resolved against the playlist URL. */
export function firstSegmentUrl(playlist: string, base: string): string | undefined {
  const map = /#EXT-X-MAP:[^\n]*URI="([^"]+)"/.exec(playlist)?.[1];
  const lines = playlist.split(/\r?\n/).map((l) => l.trim());
  const seg = lines.find((l) => l && !l.startsWith("#"));
  const ref = map ?? seg;
  if (!ref) return undefined;
  try {
    return new URL(ref, base).toString();
  } catch {
    return undefined;
  }
}

/** First variant playlist URI of an HLS master playlist, or undefined when the text is already a media playlist. */
export function firstVariantUrl(master: string, base: string): string | undefined {
  if (!master.includes("#EXT-X-STREAM-INF")) return undefined;
  const lines = master.split(/\r?\n/).map((l) => l.trim());
  const i = lines.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF"));
  const ref = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
  if (!ref) return undefined;
  try {
    return new URL(ref, base).toString();
  } catch {
    return undefined;
  }
}

// ---- Strict channel identity (never "similar name" matching) ----

export interface ChannelIdentity {
  /** Official guide id (tvg-id / iptv-org id / EPG id). */
  officialId?: string;
  name: string;
  country?: string;
  languages?: string[];
}

const QUALITY_TAGS = /\b(uhd|fhd|hd|sd|4k|8k|hevc|h265|h264|1080p?|720p?|576p?|480p?|360p?|50fps|60fps|backup|alt|ar|en)\b/g;

/** Canonical comparison key: drops quality/backup markers and bracketed notes, keeps every word that distinguishes channels (e.g. "1" vs "2"). */
export function identityName(name: string): string {
  const stripped = name.replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
  return normalizeText(stripped).replace(QUALITY_TAGS, " ").replace(/\s+/g, " ").trim();
}

const idKey = (id?: string) => (id ? id.trim().toLowerCase().replace(/@.*$/, "") : "");

/**
 * Same channel? Official ids win. Otherwise the cleaned names must be IDENTICAL, and when both sides know a
 * country (or languages) they must agree. "beIN SPORTS 1" never matches "beIN SPORTS 2" or "BeIN Sports News".
 */
export function sameChannel(a: ChannelIdentity, b: ChannelIdentity): boolean {
  const ia = idKey(a.officialId);
  const ib = idKey(b.officialId);
  if (ia && ib) return ia === ib;
  const na = identityName(a.name);
  if (!na || na !== identityName(b.name)) return false;
  if (a.country && b.country && a.country.toUpperCase() !== b.country.toUpperCase()) return false;
  if (a.languages?.length && b.languages?.length) {
    const set = new Set(a.languages.map((l) => l.toLowerCase()));
    if (!b.languages.some((l) => set.has(l.toLowerCase()))) return false;
  }
  return true;
}

// ---- Bounded retry policy ----

export interface RetryPolicy {
  /** Total attempts per source, including the first. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}
export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 600, maxDelayMs: 4000 };

export const backoffDelay = (policy: RetryPolicy, attempt: number): number =>
  Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));

/** Runs `fn` up to `policy.attempts` times, only retrying when the failure is retryable. Never loops unboundedly. */
export async function withRetry<T extends { ok: boolean; cause?: Cause }>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  onRetry?: (attempt: number, last: T) => void,
): Promise<T> {
  let last!: T;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    last = await fn(attempt);
    if (last.ok || !last.cause || !RETRYABLE.has(last.cause) || attempt === policy.attempts) return last;
    onRetry?.(attempt, last);
    await sleep(backoffDelay(policy, attempt));
  }
  return last;
}
