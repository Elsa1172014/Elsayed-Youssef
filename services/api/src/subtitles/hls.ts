/** Just enough HLS playlist parsing to pick the segment a viewer is currently watching. */
export interface MediaSegment { seq: number; url: string; duration: number }
export interface MediaPlaylist {
  segments: MediaSegment[];
  targetDuration: number;
  /** fMP4 init segment (EXT-X-MAP), if any. */
  map?: string;
  encrypted: boolean;
  live: boolean;
}

const resolve = (u: string, base: string) => new URL(u, base).toString();

export function isMaster(text: string) { return /#EXT-X-STREAM-INF/i.test(text); }

/** Lowest-bandwidth variant: the audio is the same in every variant, and the smallest download is fastest. */
export function pickVariant(text: string, base: string): string | undefined {
  const lines = text.split(/\r?\n/);
  let best: { bw: number; url: string } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXT-X-STREAM-INF:(.*)$/i.exec(lines[i]!.trim());
    if (!m) continue;
    const bw = Number(/BANDWIDTH=(\d+)/i.exec(m[1]!)?.[1] ?? Infinity);
    const uri = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith("#"))?.trim();
    if (uri && (!best || bw < best.bw)) best = { bw, url: resolve(uri, base) };
  }
  return best?.url;
}

export function parseMedia(text: string, base: string): MediaPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let seq = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i.exec(text)?.[1] ?? 0);
  const targetDuration = Number(/#EXT-X-TARGETDURATION:(\d+(\.\d+)?)/i.exec(text)?.[1] ?? 6);
  const mapUri = /#EXT-X-MAP:.*URI="([^"]+)"/i.exec(text)?.[1];
  const encrypted = /#EXT-X-KEY:(?!.*METHOD=NONE)/i.test(text);
  const segments: MediaSegment[] = [];
  let duration = targetDuration;
  for (const l of lines) {
    const d = /^#EXTINF:(\d+(\.\d+)?)/i.exec(l);
    if (d) { duration = Number(d[1]); continue; }
    if (l && !l.startsWith("#")) segments.push({ seq: seq++, url: resolve(l, base), duration });
  }
  return { segments, targetDuration, map: mapUri ? resolve(mapUri, base) : undefined, encrypted, live: !/#EXT-X-ENDLIST/i.test(text) };
}

/**
 * Next segment to subtitle. First call: ~3 segments behind the live edge (where hls.js and Safari play live streams).
 * Later calls: the segment right after the last one done, so subtitles follow the picture without gaps or repeats.
 */
export function pickSegment(p: MediaPlaylist, after?: number): MediaSegment | undefined {
  if (!p.segments.length) return undefined;
  if (after !== undefined) {
    const next = p.segments.find((s) => s.seq === after + 1);
    if (next) return next;
    if (p.segments[p.segments.length - 1]!.seq <= after) return undefined; // not published yet: try again shortly
  }
  return p.segments[Math.max(0, p.segments.length - 4)];
}
