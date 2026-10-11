import { normalizeText } from "./text";

/** Pluggable embedding provider. Swap in a multilingual model (e.g. bge-m3) behind this interface. */
export interface Embedder {
  readonly dims: number;
  embed(text: string): number[];
}

/**
 * Deterministic, dependency-free embedder using hashed character n-grams (a "fastText-lite").
 * It captures spelling/morphology similarity across Arabic and Latin text but NOT cross-language meaning;
 * that needs a real multilingual model supplied via the Embedder interface.
 */
export function hashingEmbedder(dims = 256): Embedder {
  return {
    dims,
    embed(text) {
      const v = new Array<number>(dims).fill(0);
      const t = ` ${normalizeText(text)} `;
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= t.length; i++) {
          let h = 2166136261;
          for (let j = i; j < i + n; j++) h = Math.imul(h ^ t.charCodeAt(j), 16777619) >>> 0;
          v[h % dims]! += (h & 0x10000) === 0 ? 1 : -1;
        }
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      return norm === 0 ? v : v.map((x) => x / norm);
    },
  };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot; // vectors are unit length
}

export interface VectorHit {
  id: string;
  score: number;
}

/** Brute-force nearest neighbours; fine for per-user channel lists. Use pgvector at catalog scale. */
export function nearest(query: number[], items: { id: string; vector: number[] }[], limit = 20, minScore = 0.2): VectorHit[] {
  return items
    .map((it) => ({ id: it.id, score: cosine(query, it.vector) }))
    .filter((h) => h.score >= minScore)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** Reciprocal-rank fusion of ranked id lists (lexical + semantic). */
export function fuseRankings(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}
