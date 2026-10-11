import { lookup } from "node:dns/promises";
import { assertPublicHttpUrl, isPrivateAddress } from "@receiver/core";

export interface SafeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type SafeFetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<SafeResponse>;

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;

interface Deps {
  fetchImpl?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
}

export interface OpenedResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  /** URL after redirects. */
  url: string;
}
export type SafeOpen = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<OpenedResponse>;

/**
 * Server-side opener for user-entered URLs: http(s) only, every hop (including redirects) is re-validated,
 * and hostnames are resolved and rejected if any address is private. The body is returned unread (streamed).
 * Residual risk: DNS can change between this lookup and the connection (rebinding); run the fetcher in a
 * network-restricted egress environment as defence in depth (docs/DEPLOYMENT.md).
 */
export function createSafeOpen({ fetchImpl = fetch, resolve }: Deps = {}): SafeOpen {
  const resolveAll = resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address));
  return async (rawUrl, init = {}) => {
    let url = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = assertPublicHttpUrl(url);
      const host = parsed.hostname.replace(/^\[|\]$/g, "");
      const addrs = isPrivateAddress(host) || /^[\d.]+$/.test(host) || host.includes(":") ? [host] : await resolveAll(host);
      if (addrs.length === 0 || addrs.some(isPrivateAddress)) throw new Error("Host resolves to a private address");
      const res = await fetchImpl(parsed, { ...init, redirect: "manual" });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => undefined);
        url = new URL(res.headers.get("location")!, parsed).toString();
        continue;
      }
      return { status: res.status, headers: res.headers, body: res.body, url: parsed.toString() };
    }
    throw new Error("Too many redirects");
  };
}

/** Like {@link createSafeOpen} but buffers the (size-capped) body as text. */
export function createSafeFetch(deps: Deps = {}): SafeFetch {
  const open = createSafeOpen(deps);
  return async (url, init) => {
    const res = await open(url, init);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      async text() {
        const reader = res.body?.getReader();
        if (!reader) return "";
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_BYTES) {
            await reader.cancel();
            throw new Error("Response too large");
          }
          chunks.push(value);
        }
        return Buffer.concat(chunks).toString("utf8");
      },
    };
  };
}
