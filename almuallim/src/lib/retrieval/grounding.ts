export interface Passage {
  chunkId: string;
  lessonId: string | null;
  lessonTitle: string | null;
  pageStart: number;
  pageEnd: number;
  content: string;
  vectorSimilarity: number;
  lexicalScore: number;
  fusedScore: number;
}

export type GroundingLevel = "strong" | "weak" | "none";

export interface GroundingThresholds {
  strongVector: number;   // cosine similarity at/above which a passage is treated as clearly relevant
  weakVector: number;     // below this (and no lexical hit) retrieval is treated as a miss
  lexicalHit: number;     // ts_rank_cd at/above which a lexical match counts as corroboration
}

/**
 * UNCALIBRATED defaults for text-embedding-3-small on Arabic. They must be tuned on a labelled set of
 * (question → expected page) pairs from the real textbook before a pilot; see docs/acceptance-tests.md B6/C3.
 */
export const DEFAULT_THRESHOLDS: GroundingThresholds = { strongVector: 0.42, weakVector: 0.28, lexicalHit: 0.05 };

export interface GroundingAssessment {
  level: GroundingLevel;
  topVector: number;
  topLexical: number;
  passageCount: number;
}

export function assessGrounding(passages: Passage[], t: GroundingThresholds = DEFAULT_THRESHOLDS): GroundingAssessment {
  const topVector = Math.max(0, ...passages.map((p) => p.vectorSimilarity));
  const topLexical = Math.max(0, ...passages.map((p) => p.lexicalScore));
  const base = { topVector, topLexical, passageCount: passages.length };
  if (passages.length === 0) return { level: "none", ...base };
  const lexical = topLexical >= t.lexicalHit;
  if (topVector >= t.strongVector || (topVector >= t.weakVector && lexical)) return { level: "strong", ...base };
  if (topVector >= t.weakVector || lexical) return { level: "weak", ...base };
  return { level: "none", ...base };
}

/** "ص ٢" or "ص ٢–٣" using Arabic-Indic digits; this is the citation label shown to students. */
export function pageLabel(start: number, end: number): string {
  const ar = (n: number) => String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]!);
  return start === end ? `ص ${ar(start)}` : `ص ${ar(start)}–${ar(end)}`;
}
