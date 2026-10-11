export type Provenance = "official" | "fast" | "directory" | "fta";

export interface CatalogChannel {
  id: string;
  name: string;
  country?: string;
  languages: string[];
  categories: string[];
  logoUrl?: string;
  website?: string;
  provenance: Provenance;
  streams: { url: string; quality?: string }[];
}

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function publicHttp(u: string | undefined): string | undefined {
  try {
    const p = u ? new URL(u) : undefined;
    return p && (p.protocol === "https:" || p.protocol === "http:") ? p.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Maps the open iptv-org dataset (channels.json + streams.json) into catalog entries.
 * Skips NSFW and closed channels, and streams that need special request headers (user-agent/referrer
 * spoofing), keeping only plain public stream URLs. Channels with no usable stream are dropped.
 */
export function mapIptvOrg(channels: unknown, streams: unknown, logos?: unknown): CatalogChannel[] {
  if (!Array.isArray(channels) || !Array.isArray(streams)) return [];
  const byChannel = new Map<string, { url: string; quality?: string }[]>();
  for (const raw of streams as Json[]) {
    const id = str(raw.channel);
    const url = publicHttp(str(raw.url));
    if (!id || !url || str(raw.user_agent) || str(raw.referrer)) continue;
    const list = byChannel.get(id) ?? [];
    if (!list.some((x) => x.url === url)) list.push({ url, quality: str(raw.quality) });
    byChannel.set(id, list);
  }
  const logoBy = new Map<string, string>();
  if (Array.isArray(logos)) {
    for (const l of logos as Json[]) {
      const id = str(l.channel);
      const u = publicHttp(str(l.url));
      if (id && u && !logoBy.has(id)) logoBy.set(id, u);
    }
  }
  const out: CatalogChannel[] = [];
  for (const raw of channels as Json[]) {
    const id = str(raw.id);
    const name = str(raw.name);
    if (!id || !name || raw.is_nsfw === true || str(raw.closed)) continue;
    const st = byChannel.get(id);
    if (!st?.length) continue;
    out.push({
      id,
      name,
      country: str(raw.country),
      languages: strs(raw.languages),
      categories: strs(raw.categories),
      logoUrl: logoBy.get(id) ?? publicHttp(str(raw.logo)),
      website: publicHttp(str(raw.website)),
      provenance: "directory",
      streams: st,
    });
  }
  return out;
}

/**
 * Loads a maintainer-curated list of official/FAST channels the owner has verified are published
 * by the channel itself. Entries failing validation are dropped, never guessed.
 */
export function parseOfficialList(json: unknown): CatalogChannel[] {
  if (!Array.isArray(json)) return [];
  const out: CatalogChannel[] = [];
  for (const raw of json as Json[]) {
    const id = str(raw.id);
    const name = str(raw.name);
    const provenance = raw.provenance === "fast" ? "fast" : raw.provenance === "fta" ? "fta" : raw.provenance === "official" ? "official" : undefined;
    const streams = (Array.isArray(raw.streams) ? (raw.streams as Json[]) : [])
      .map((x) => ({ url: publicHttp(str(x.url)), quality: str(x.quality) }))
      .filter((x): x is { url: string; quality: string | undefined } => !!x.url);
    if (!id || !name || !provenance || !streams.length) continue;
    out.push({
      id: `${provenance}:${id}`, name, provenance, streams,
      country: str(raw.country), languages: strs(raw.languages), categories: strs(raw.categories),
      logoUrl: publicHttp(str(raw.logo)), website: publicHttp(str(raw.website)),
    });
  }
  return out;
}
