import {
  assertPublicHttpUrl, causeFromHttp, declaredCodecs, detectProtection, detectStreamKind, firstSegmentUrl, firstVariantUrl, looksLikeMedia,
  type Cause, type Diagnosis, type ProbeStep, type Protection,
} from "@receiver/core";
import type { SafeOpen } from "./safeFetch";

const REQ_TIMEOUT_MS = 5000;
const MAX_MANIFEST = 512 * 1024;
const UA = "Mozilla/5.0 (compatible; SmartReceiver)";

/** Reads at most `max` bytes and cancels the rest, so live (endless) streams and big segments are never downloaded. */
async function readUpTo(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(Math.min(total, max));
  let o = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.max(0, Math.min(c.byteLength, out.length - o)));
    out.set(part, o);
    o += part.length;
  }
  return out;
}

interface Fetched {
  status: number;
  contentType: string;
  bytes: Uint8Array;
  finalUrl: string;
}

async function get(open: SafeOpen, url: string, max: number, headers: Record<string, string> = {}): Promise<Fetched> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await open(url, { signal: ctl.signal, headers: { "user-agent": UA, accept: "*/*", ...headers } });
    const bytes = res.status >= 200 && res.status < 300 ? await readUpTo(res.body, max) : (await res.body?.cancel().catch(() => undefined), new Uint8Array());
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", bytes, finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const errCause = (e: unknown): Cause => ((e as Error).name === "AbortError" ? "timeout" : "network");

/**
 * Probes a stream the way a player would, and goes beyond "HTTP 200": for HLS it follows master -> variant -> first
 * segment and checks the bytes are really media (MPEG-TS sync byte, fMP4 boxes, ...). The final word on "playing"
 * still belongs to the real player in the browser; this finds the cause and filters candidates cheaply.
 */
export async function diagnoseStream(open: SafeOpen, rawUrl: string, sign: (url: string) => string): Promise<Diagnosis> {
  const steps: ProbeStep[] = [];
  const empty: Protection = { drm: [], encrypted: false, licenseUrls: [] };
  const done = (d: Partial<Diagnosis> & { cause: Cause }): Diagnosis => ({
    ok: d.cause === "none", url: rawUrl, proxy: sign(rawUrl), kind: "unknown", codecs: [], protection: empty, steps, ...d,
  });
  const fail = (id: ProbeStep["id"], detail: string, d: Partial<Diagnosis> & { cause: Cause }) => {
    steps.push({ id, ok: false, detail });
    return done(d);
  };

  try {
    assertPublicHttpUrl(rawUrl);
  } catch (e) {
    return { ...fail("url", (e as Error).message, { cause: "invalid_url" }), proxy: "" };
  }
  steps.push({ id: "url", ok: true, detail: new URL(rawUrl).host });

  const t0 = Date.now();
  let first: Fetched;
  try {
    first = await get(open, rawUrl, MAX_MANIFEST);
  } catch (e) {
    const cause = errCause(e);
    return fail("server", cause === "timeout" ? "no answer in time" : "could not connect", { cause });
  }
  const latencyMs = Date.now() - t0;
  const httpCause = causeFromHttp(first.status);
  if (httpCause !== "none") return fail("server", `HTTP ${first.status}`, { cause: httpCause, httpStatus: first.status, latencyMs });
  steps.push({ id: "server", ok: true, detail: `HTTP ${first.status} in ${latencyMs} ms` });

  const body = text(first.bytes.subarray(0, 2048));
  const kind = detectStreamKind(first.finalUrl, first.contentType, body);
  const base = { httpStatus: first.status, latencyMs, kind };
  if (kind === "html") return fail("type", "the server answered with a web page, not a stream", { ...base, cause: "not_media" });
  steps.push({ id: "type", ok: true, detail: kind });

  // Direct media (progressive MP4/TS/WebM/audio): the first bytes must be media.
  if (kind !== "hls" && kind !== "dash") {
    steps.push({ id: "manifest", ok: true, skipped: true, detail: "not a playlist" });
    steps.push({ id: "protection", ok: true, skipped: true, detail: "none declared" });
    if (!looksLikeMedia(first.bytes)) return fail("media", "response is not media data", { ...base, cause: "not_media" });
    steps.push({ id: "media", ok: true, detail: `${first.bytes.length} bytes of media` });
    return done({ ...base, cause: "none" });
  }

  const manifest = text(first.bytes);
  if (kind === "hls" && !manifest.trimStart().startsWith("#EXTM3U")) return fail("manifest", "not a valid HLS playlist", { ...base, cause: "not_media" });
  if (kind === "dash" && !/<MPD[\s>]/.test(manifest)) return fail("manifest", "not a valid DASH manifest", { ...base, cause: "not_media" });
  let protection = detectProtection(manifest);
  const codecs = declaredCodecs(manifest);
  steps.push({ id: "manifest", ok: true, detail: `${kind.toUpperCase()}${codecs.length ? ` (${codecs.join(", ")})` : ""}` });

  let playlist = manifest;
  let playlistUrl = first.finalUrl;
  if (kind === "hls") {
    const variant = firstVariantUrl(manifest, first.finalUrl);
    if (variant) {
      try {
        const v = await get(open, variant, MAX_MANIFEST);
        const vc = causeFromHttp(v.status);
        if (vc !== "none") return fail("media", `variant playlist: HTTP ${v.status}`, { ...base, codecs, protection, cause: vc });
        playlist = text(v.bytes);
        playlistUrl = v.finalUrl;
        const p = detectProtection(playlist);
        protection = { drm: [...new Set([...protection.drm, ...p.drm])], encrypted: protection.encrypted || p.encrypted, licenseUrls: [...new Set([...protection.licenseUrls, ...p.licenseUrls])] };
      } catch (e) {
        return fail("media", "variant playlist unreachable", { ...base, codecs, protection, cause: errCause(e) });
      }
    }
  }
  steps.push({ id: "protection", ok: protection.drm.length === 0, detail: protection.drm.length ? `DRM: ${protection.drm.join(", ")}` : protection.encrypted ? "AES-128 (player decrypts)" : "clear" });
  if (protection.drm.length > 0) return done({ ...base, codecs, protection, cause: "drm_protected" });

  // Encrypted (AES-128) segments cannot be sniffed, and DASH segment addressing is the player's job: verified by actual playback.
  if (kind === "dash" || protection.encrypted) {
    steps.push({ id: "media", ok: true, skipped: true, detail: "checked by the player" });
    return done({ ...base, codecs, protection, cause: "none" });
  }

  const seg = firstSegmentUrl(playlist, playlistUrl);
  if (!seg) return fail("media", "playlist lists no media segments", { ...base, codecs, protection, cause: "no_media_data" });
  try {
    const s = await get(open, seg, 4096, { range: "bytes=0-4095" });
    const sc = causeFromHttp(s.status === 206 ? 200 : s.status);
    if (sc !== "none") return fail("media", `segment: HTTP ${s.status}`, { ...base, codecs, protection, cause: sc === "gone" ? "no_media_data" : sc });
    if (!looksLikeMedia(s.bytes)) return fail("media", "segment is not media data", { ...base, codecs, protection, cause: "no_media_data" });
    steps.push({ id: "media", ok: true, detail: `segment answers with ${s.bytes.length}+ bytes of media` });
  } catch (e) {
    return fail("media", "segment unreachable", { ...base, codecs, protection, cause: errCause(e) });
  }
  return done({ ...base, codecs, protection, cause: "none" });
}
