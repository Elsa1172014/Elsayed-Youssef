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

/**
 * Server-side fetcher for user-entered URLs: http(s) only, every hop (including redirects) is re-validated,
 * hostnames are resolved and rejected if any address is private, and bodies are size-capped.
 * Residual risk: DNS can change between this lookup and the connection (rebinding); run the fetcher in a
 * network-restricted egress environment as defence in depth (docs/DEPLOYMENT.md).
 */
export function createSafeFetch({ fetchImpl = fetch, resolve }: Deps = {}): SafeFetch {
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
        url = new URL(res.headers.get("location")!, parsed).toString();
        continue;
      }
      return {
        ok: res.ok,
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
    }
    throw new Error("Too many redirects");
  };
}
