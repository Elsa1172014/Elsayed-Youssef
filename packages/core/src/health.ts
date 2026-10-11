export interface ProbeResult {
  status: "ok" | "dead";
  latencyMs?: number;
  reason?: string;
}

export type FetchLike = (url: string, init?: { method?: string; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/**
 * Checks that a stream URL answers and, for HLS, that the body looks like a playlist.
 * Downloads at most the manifest (never media segments) and is intended for catalog/user streams
 * the caller is allowed to check. The fetcher injected by the caller must apply SSRF protections.
 */
export async function probeStream(
  url: string,
  fetcher: FetchLike,
  opts: { timeoutMs?: number; now?: () => number } = {},
): Promise<ProbeResult> {
  const now = opts.now ?? Date.now;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 8000);
  const t0 = now();
  try {
    const res = await fetcher(url, { method: "GET", signal: ctl.signal });
    const latencyMs = now() - t0;
    if (!res.ok) return { status: "dead", latencyMs, reason: `HTTP ${res.status}` };
    if (/\.m3u8(\?|$)/i.test(url)) {
      const body = (await res.text()).slice(0, 4096);
      if (!body.includes("#EXTM3U")) return { status: "dead", latencyMs, reason: "Not an HLS playlist" };
    }
    return { status: "ok", latencyMs };
  } catch (e) {
    return { status: "dead", reason: (e as Error).name === "AbortError" ? "Timeout" : "Network error" };
  } finally {
    clearTimeout(timer);
  }
}

/** Orders candidate streams: healthy first, then lowest latency, unknown last-but-before-dead. */
export function rankStreams<T extends { status: "unknown" | "ok" | "dead"; latencyMs?: number | null }>(streams: T[]): T[] {
  const weight = { ok: 0, unknown: 1, dead: 2 } as const;
  return [...streams].sort(
    (a, b) => weight[a.status] - weight[b.status] || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity),
  );
}
