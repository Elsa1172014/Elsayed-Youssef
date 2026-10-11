import { expandTokens, normalizeText, similarity, tokenize } from "./text";

export interface SearchableChannel {
  id: string;
  name: string;
  group?: string;
  hidden?: boolean;
}

export interface NowPlaying {
  title: string;
  category?: string;
}

export interface SearchHit {
  id: string;
  score: number;
}

/**
 * Lexical search over a user's own channels (and what is on now). Grounded strictly in the supplied
 * catalog: it can only return ids that were passed in, never invented streams.
 */
export function searchChannels(
  query: string,
  channels: SearchableChannel[],
  nowPlaying: Record<string, NowPlaying | undefined> = {},
  limit = 20,
): SearchHit[] {
  const qTokens = expandTokens(tokenize(query));
  if (qTokens.length === 0) return [];
  const qNorm = normalizeText(query);
  const hits: SearchHit[] = [];
  for (const c of channels) {
    if (c.hidden) continue;
    const nameN = normalizeText(c.name);
    const nameTokens = expandTokens(tokenize(c.name));
    const groupTokens = expandTokens(tokenize(c.group ?? ""));
    const np = nowPlaying[c.id];
    const showTokens = expandTokens(tokenize(`${np?.title ?? ""} ${np?.category ?? ""}`));
    let score = 0;
    if (nameN === qNorm) score += 10;
    else if (nameN.includes(qNorm)) score += 6;
    for (const t of qTokens) {
      if (nameTokens.includes(t)) score += 3;
      else if (nameTokens.some((n) => n.startsWith(t) && t.length >= 2)) score += 1.5;
      if (groupTokens.includes(t)) score += 1.5;
      if (showTokens.includes(t)) score += 2;
    }
    score += 2 * similarity(query, c.name);
    if (score >= 2) hits.push({ id: c.id, score: Math.round(score * 100) / 100 });
  }
  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
