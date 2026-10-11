import { mapIptvOrg, parseOfficialList, probeStream, type CatalogChannel } from "@receiver/core";
import type { SafeFetch } from "../safeFetch";
import type { Store } from "../store";

export const IPTV_ORG_API = process.env.IPTV_ORG_API ?? "https://iptv-org.github.io/api";

export interface SyncResult {
  channels: number;
  streams: number;
  pruned?: { closed: number; streamsRemoved: number };
  skippedPrune?: string;
}

/**
 * Pulls the full open iptv-org dataset (every country, language and category) into the shared catalog.
 * Honors their blocklist (takedowns/NSFW) and excludes adult, closed and header-dependent streams.
 * Entries that disappeared upstream are retired, unless the fetch looks truncated.
 */
export async function syncIptvOrg(store: Store, fetcher: SafeFetch, base = IPTV_ORG_API): Promise<SyncResult> {
  const getJson = async (name: string, required: boolean) => {
    const res = await fetcher(`${base}/${name}.json`);
    if (!res.ok) {
      if (required) throw new Error(`${name}.json returned HTTP ${res.status}`);
      return undefined;
    }
    return JSON.parse(await res.text()) as unknown;
  };
  const channels = await getJson("channels", true);
  const streams = await getJson("streams", true);
  // Blocklist is a legal/safety input: if it cannot be fetched we refuse to sync rather than risk listing removed channels.
  const blocklist = await getJson("blocklist", true);
  const [logos, feeds] = [await getJson("logos", false), await getJson("feeds", false)];
  const mapped = mapIptvOrg(channels, streams, { logos, feeds, blocklist });
  const result: SyncResult = { channels: mapped.length, streams: mapped.reduce((n, c) => n + c.streams.length, 0) };
  const before = await store.countActiveDirectory();
  const stamp = await store.upsertCatalog(mapped);
  if (before > 0 && mapped.length < before * 0.5) {
    result.skippedPrune = `only ${mapped.length} channels vs ${before} before; looks incomplete`;
  } else {
    result.pruned = await store.pruneDirectory(stamp);
  }
  await store.setSyncState("iptv-org", JSON.stringify(result));
  return result;
}

/** Loads the maintainer-curated list of verified official/FAST channels (see catalog/official.json). */
export async function syncOfficial(store: Store, json: unknown): Promise<{ channels: number }> {
  const mapped: CatalogChannel[] = parseOfficialList(json);
  await store.upsertCatalog(mapped);
  return { channels: mapped.length };
}

/** Probes the least-recently-checked streams (manifest only; no media downloaded) with bounded concurrency. */
export async function checkStreamHealth(store: Store, fetcher: SafeFetch, batch = 50, concurrency = 10): Promise<{ checked: number; dead: number }> {
  const due = await store.listStreamsToCheck(batch);
  let dead = 0;
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < due.length; i = next++) {
      const s = due[i]!;
      const r = await probeStream(s.url, (u, init) => fetcher(u, init), { timeoutMs: 6000 });
      await store.recordStreamHealth(s.id, r.status, r.latencyMs);
      if (r.status === "dead") dead++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
  return { checked: due.length, dead };
}
