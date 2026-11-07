/**
 * Receiver libraries through the receivers' own documented HTTP APIs (no scraping, no decryption):
 *  - SiliconDust HDHomeRun: GET /lineup.json → [{ GuideNumber, GuideName, URL, DRM? }]
 *  - Enigma2 / OpenWebif:   GET /api/getallservices → { services: [{ servicename, subservices: [{ servicename, servicereference }] }] }
 * The receiver decodes with the owner's own tuner/subscription; channels flagged as DRM-protected by the device are skipped.
 */
export interface ReceiverChannel {
  name: string;
  url: string;
  group?: string;
  number?: string;
}

export type ReceiverKind = "hdhomerun" | "enigma2";

/** Which API a receiver URL points at, and the request to make. */
export function receiverEndpoint(baseUrl: string): { kind: ReceiverKind; url: string } {
  const u = new URL(baseUrl);
  if (/lineup\.json$/i.test(u.pathname)) return { kind: "hdhomerun", url: u.toString() };
  if (/\/api\/getallservices$/i.test(u.pathname)) return { kind: "enigma2", url: u.toString() };
  if (/hdhomerun/i.test(u.hostname)) return { kind: "hdhomerun", url: new URL("/lineup.json", u).toString() };
  return { kind: "enigma2", url: new URL("/api/getallservices", u).toString() };
}

export function parseHdHomeRunLineup(data: unknown): ReceiverChannel[] {
  if (!Array.isArray(data)) return [];
  const out: ReceiverChannel[] = [];
  for (const x of data as Record<string, unknown>[]) {
    const url = typeof x.URL === "string" ? x.URL : "";
    const name = typeof x.GuideName === "string" ? x.GuideName.trim() : "";
    if (!name || !/^https?:\/\//i.test(url)) continue;
    if (x.DRM === 1 || x.DRM === "1") continue; // device reports copy-protected channel: not playable outside its own apps
    out.push({ name, url, number: typeof x.GuideNumber === "string" ? x.GuideNumber : undefined, group: "HDHomeRun" });
  }
  return out;
}

/** OpenWebif services → stream URLs on the receiver's streaming port (default 8001). Markers and folders are skipped. */
export function parseOpenWebifServices(data: unknown, baseUrl: string, streamPort = 8001): ReceiverChannel[] {
  const services = (data as { services?: unknown })?.services;
  if (!Array.isArray(services)) return [];
  const base = new URL(baseUrl);
  const host = `${base.protocol}//${base.hostname}:${streamPort}`;
  const out: ReceiverChannel[] = [];
  const seen = new Set<string>();
  for (const bouquet of services as Record<string, unknown>[]) {
    const group = typeof bouquet.servicename === "string" ? bouquet.servicename : undefined;
    const subs = Array.isArray(bouquet.subservices) ? (bouquet.subservices as Record<string, unknown>[]) : [];
    for (const s of subs) {
      const ref = typeof s.servicereference === "string" ? s.servicereference : "";
      const name = typeof s.servicename === "string" ? s.servicename.trim() : "";
      // "1:64:..." are bouquet markers (labels); "1:7:..." are sub-folders; only playable services ("1:0:...") are kept.
      if (!name || !/^1:0:/.test(ref) || seen.has(ref)) continue;
      seen.add(ref);
      out.push({ name, url: `${host}/${ref}`, group });
    }
  }
  return out;
}
