import { mapIptvOrg, parseOfficialList, probeStream, type CatalogChannel } from "@receiver/core";
import type { SafeFetch } from "../safeFetch";
import type { Store } from "../store";

export const IPTV_ORG_API = "https://iptv-org.github.io/api";

/** Pulls the open iptv-org dataset into the shared catalog. Run on a schedule (e.g. nightly). */
export async function syncIptvOrg(store: Store, fetcher: SafeFetch, base = IPTV_ORG_API): Promise<{ channels: number }> {
  const getJson = async (name: string, required: boolean) => {
    const res = await fetcher(`${base}/${name}.json`);
    if (!res.ok) {
      if (required) throw new Error(`${name}.json returned HTTP ${res.status}`);
      return undefined;
    }
    return JSON.parse(await res.text()) as unknown;
  };
  const [channels, streams, logos] = [await getJson("channels", true), await getJson("streams", true), await getJson("logos", false)];
  const mapped = mapIptvOrg(channels, streams, logos);
  await store.upsertCatalog(mapped);
  return { channels: mapped.length };
}

/** Loads the maintainer-curated list of verified official/FAST channels (see catalog/official.json). */
export async function syncOfficial(store: Store, json: unknown): Promise<{ channels: number }> {
  const mapped: CatalogChannel[] = parseOfficialList(json);
  await store.upsertCatalog(mapped);
  return { channels: mapped.length };
}

/** Probes the least-recently-checked streams and records their health. Manifest only; no media is downloaded. */
export async function checkStreamHealth(store: Store, fetcher: SafeFetch, batch = 50): Promise<{ checked: number; dead: number }> {
  let dead = 0;
  const due = await store.listStreamsToCheck(batch);
  for (const s of due) {
    const r = await probeStream(s.url, (u, init) => fetcher(u, init));
    await store.recordStreamHealth(s.id, r.status, r.latencyMs);
    if (r.status === "dead") dead++;
  }
  return { checked: due.length, dead };
}
