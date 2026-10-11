import { similarity } from "./text";
import type { XmltvChannel } from "./xmltv";

export interface MapSuggestion {
  channelId: string;
  epgChannelId: string;
  confidence: number;
}

/**
 * Suggests EPG channel ids for channels lacking one. Suggestions only: the user approves or rejects,
 * so they stay in control of their own mapping.
 */
export function suggestEpgMappings(
  channels: { id: string; name: string; epgChannelId?: string }[],
  guide: XmltvChannel[],
  threshold = 0.75,
): MapSuggestion[] {
  const out: MapSuggestion[] = [];
  for (const c of channels) {
    if (c.epgChannelId) continue;
    let best: MapSuggestion | undefined;
    for (const g of guide) {
      const conf = Math.max(0, ...g.displayNames.map((n) => similarity(c.name, n)), similarity(c.name, g.id));
      if (conf >= threshold && (!best || conf > best.confidence)) {
        best = { channelId: c.id, epgChannelId: g.id, confidence: Math.round(conf * 100) / 100 };
      }
    }
    if (best) out.push(best);
  }
  return out;
}
