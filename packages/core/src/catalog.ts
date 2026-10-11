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

const MAX_URL = 2048;

function publicHttp(u: string | undefined): string | undefined {
  if (u && u.length > MAX_URL) return undefined;
  try {
    const p = u ? new URL(u) : undefined;
    return p && (p.protocol === "https:" || p.protocol === "http:") ? p.toString() : undefined;
  } catch {
    return undefined;
  }
}

export interface IptvOrgExtras {
  /** logos.json: preferred in-use, widest logo per channel. */
  logos?: unknown;
  /** feeds.json: source of per-channel languages. */
  feeds?: unknown;
  /** blocklist.json: channels removed from the directory (takedowns, NSFW); always excluded. */
  blocklist?: unknown;
}

/**
 * Maps the open iptv-org dataset (channels.json + streams.json, plus optional logos/feeds/blocklist)
 * into catalog entries. Excluded: blocklisted, closed, NSFW/adult-category channels, streams that need
 * special request headers (user-agent/referrer), non-HTTP(S) streams (not playable in a browser), and streams
 * not linked to a vetted channel. Channels with no usable stream are dropped.
 */
export function mapIptvOrg(channels: unknown, streams: unknown, extras: IptvOrgExtras = {}): CatalogChannel[] {
  if (!Array.isArray(channels) || !Array.isArray(streams)) return [];
  const blocked = new Set<string>();
  if (Array.isArray(extras.blocklist)) for (const b of extras.blocklist as Json[]) if (str(b.channel)) blocked.add(str(b.channel)!);

  const byChannel = new Map<string, { url: string; quality?: string }[]>();
  for (const raw of streams as Json[]) {
    const id = str(raw.channel);
    const url = publicHttp(str(raw.url));
    if (!id || !url || str(raw.user_agent) || str(raw.referrer)) continue;
    const list = byChannel.get(id) ?? [];
    if (!list.some((x) => x.url === url)) list.push({ url, quality: str(raw.quality) });
    byChannel.set(id, list);
  }

  const logoBy = new Map<string, { url: string; score: number }>();
  if (Array.isArray(extras.logos)) {
    for (const l of extras.logos as Json[]) {
      const id = str(l.channel);
      const u = publicHttp(str(l.url));
      if (!id || !u) continue;
      const score = (l.in_use === true ? 1_000_000 : 0) + (typeof l.width === "number" ? l.width : 0);
      if (score > (logoBy.get(id)?.score ?? -1)) logoBy.set(id, { url: u, score });
    }
  }

  const langBy = new Map<string, Set<string>>();
  if (Array.isArray(extras.feeds)) {
    for (const f of extras.feeds as Json[]) {
      const id = str(f.channel);
      if (!id) continue;
      const set = langBy.get(id) ?? new Set<string>();
      for (const l of strs(f.languages)) set.add(l);
      langBy.set(id, set);
    }
  }

  const out: CatalogChannel[] = [];
  for (const raw of channels as Json[]) {
    const id = str(raw.id);
    const name = str(raw.name);
    if (!id || !name || blocked.has(id) || raw.is_nsfw === true || str(raw.closed)) continue;
    const categories = strs(raw.categories);
    if (categories.includes("xxx")) continue;
    const st = byChannel.get(id);
    if (!st?.length) continue;
    out.push({
      id,
      name,
      country: str(raw.country),
      languages: [...(langBy.get(id) ?? [])],
      categories,
      logoUrl: logoBy.get(id)?.url ?? publicHttp(str(raw.logo)),
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

export interface PremiumChannel {
  id: string;
  name: string;
  country?: string;
  languages: string[];
  categories: string[];
  logoUrl?: string;
  website?: string;
}

/**
 * Metadata-only directory of channels that have NO free public stream in the open directory
 * (typically subscription/encrypted/regional channels). It carries no stream URLs of any kind: playback is only
 * possible through a subscription the user owns and enters themselves. Same exclusions as the free catalog
 * (blocklisted, closed, NSFW/adult). We cannot tell which of these are encrypted; "no free stream" is what we know.
 */
export function mapIptvOrgPremium(channels: unknown, streams: unknown, extras: IptvOrgExtras = {}): PremiumChannel[] {
  if (!Array.isArray(channels) || !Array.isArray(streams)) return [];
  const free = new Set(mapIptvOrg(channels, streams, extras).map((c) => c.id));
  const blocked = new Set<string>();
  if (Array.isArray(extras.blocklist)) for (const b of extras.blocklist as Json[]) if (str(b.channel)) blocked.add(str(b.channel)!);
  const logoBy = new Map<string, { url: string; score: number }>();
  if (Array.isArray(extras.logos)) {
    for (const l of extras.logos as Json[]) {
      const id = str(l.channel);
      const u = publicHttp(str(l.url));
      if (!id || !u) continue;
      const score = (l.in_use === true ? 1_000_000 : 0) + (typeof l.width === "number" ? l.width : 0);
      if (score > (logoBy.get(id)?.score ?? -1)) logoBy.set(id, { url: u, score });
    }
  }
  const langBy = new Map<string, Set<string>>();
  if (Array.isArray(extras.feeds)) {
    for (const f of extras.feeds as Json[]) {
      const id = str(f.channel);
      if (!id) continue;
      const set = langBy.get(id) ?? new Set<string>();
      for (const l of strs(f.languages)) set.add(l);
      langBy.set(id, set);
    }
  }
  const out: PremiumChannel[] = [];
  for (const raw of channels as Json[]) {
    const id = str(raw.id);
    const name = str(raw.name);
    if (!id || !name || free.has(id) || blocked.has(id) || raw.is_nsfw === true || str(raw.closed)) continue;
    const categories = strs(raw.categories);
    if (categories.includes("xxx")) continue;
    out.push({
      id, name, country: str(raw.country), languages: [...(langBy.get(id) ?? [])], categories,
      logoUrl: logoBy.get(id)?.url ?? publicHttp(str(raw.logo)), website: publicHttp(str(raw.website)),
    });
  }
  return out;
}
