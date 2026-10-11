import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type { SafeOpen } from "./safeFetch";

/**
 * Stateless, signed HLS relay. Browsers cannot play most free streams directly (no CORS headers, or plain http
 * on an https page), so the API fetches manifests/segments and rewrites every link inside a manifest to point back
 * here. Each URL is HMAC-signed with an expiry: only URLs reachable from a signed channel URL can be relayed, so
 * this is not an open proxy. Upstream fetching goes through the SSRF-guarded opener.
 */
export const PROXY_TTL_SECONDS = 6 * 3600;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 25 * 1024 * 1024;
const MANIFEST_TIMEOUT_MS = 12_000;
const SEGMENT_TIMEOUT_MS = 25_000;

export const randomProxyKey = () => randomBytes(32);

const b64 = (b: Buffer) => b.toString("base64url");
const mac = (key: Buffer, exp: number, url: string) => b64(createHmac("sha256", key).update(`${exp}.${url}`).digest()).slice(0, 32);

export function signProxyUrl(key: Buffer, url: string, now: number): string {
  const exp = Math.floor(now / 1000) + PROXY_TTL_SECONDS;
  return `/v1/proxy?u=${b64(Buffer.from(url))}&e=${exp}&s=${mac(key, exp, url)}`;
}

export function verifyProxyQuery(key: Buffer, q: Record<string, unknown>, now: number): string | undefined {
  const { u, e, s } = q;
  if (typeof u !== "string" || typeof e !== "string" || typeof s !== "string" || u.length > 4096) return undefined;
  const exp = Number(e);
  if (!Number.isInteger(exp) || exp * 1000 < now) return undefined;
  const url = Buffer.from(u, "base64url").toString("utf8");
  const want = Buffer.from(mac(key, exp, url));
  const got = Buffer.from(s);
  return want.length === got.length && timingSafeEqual(want, got) ? url : undefined;
}

/** Rewrites every URI in an HLS playlist (segments, variants, keys, init maps, renditions) to signed proxy URLs. */
export function rewriteManifest(text: string, baseUrl: string, sign: (absolute: string) => string): string {
  const abs = (ref: string) => {
    try {
      return new URL(ref, baseUrl).toString();
    } catch {
      return undefined;
    }
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        return line.replace(/URI="([^"]*)"/g, (m, ref: string) => {
          const a = abs(ref);
          return a && /^https?:/i.test(a) ? `URI="${sign(a)}"` : m;
        });
      }
      const a = abs(t);
      return a && /^https?:/i.test(a) ? sign(a) : line;
    })
    .join("\n");
}

const looksLikeManifest = (contentType: string, url: string) => /mpegurl/i.test(contentType) || /\.m3u8?(\?|$)/i.test(url);

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: string | Readable;
}

const fail = (status: number, error: string): ProxyResult => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify({ error }) });

export async function relay(open: SafeOpen, url: string, sign: (absolute: string) => string, range?: string): Promise<ProxyResult> {
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const res = await open(url, {
      signal: ctl.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; SmartReceiver)", accept: "*/*", ...(range ? { range } : {}) },
    });
    if (res.status === 401 || res.status === 403 || res.status === 451) return fail(502, "The stream's server refused the request (blocked, geo-restricted or needs a login)");
    if (res.status === 404 || res.status === 410) return fail(502, "This stream is no longer available");
    if (res.status >= 400) return fail(502, `The stream's server answered with an error (${res.status})`);
    const contentType = res.headers.get("content-type") ?? "";
    if (looksLikeManifest(contentType, res.url)) {
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_MANIFEST_BYTES) {
          await reader.cancel();
          return fail(502, "Playlist too large");
        }
        chunks.push(value);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trimStart().startsWith("#EXTM3U")) return fail(502, "The server did not return a valid playlist");
      return { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" }, body: rewriteManifest(text, res.url, sign) };
    }
    if (!res.body) return fail(502, "Empty response from the stream");
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(), SEGMENT_TIMEOUT_MS);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_SEGMENT_BYTES) return fail(502, "Segment too large");
    let sent = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        sent += chunk.length;
        if (sent > MAX_SEGMENT_BYTES) {
          ctl.abort();
          return cb(new Error("Segment too large"));
        }
        cb(null, chunk);
      },
      flush(cb) {
        clearTimeout(timer);
        cb();
      },
    });
    const headers: Record<string, string> = { "content-type": contentType || "video/mp2t" };
    for (const h of ["content-length", "content-range", "accept-ranges"]) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    return { status: res.status === 206 ? 206 : 200, headers, body: Readable.fromWeb(res.body as never).pipe(cap) };
  } catch (e) {
    clearTimeout(timer);
    const aborted = (e as Error).name === "AbortError";
    return aborted ? fail(504, "The stream's server did not respond in time") : fail(502, "Could not reach the stream's server (it may be offline)");
  }
}
