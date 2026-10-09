/**
 * Decides whether a camera capture matches an indexed textbook page. Pure and unit-tested.
 * Signals come from the database (`match_pages`) and from the OCR step; identity is NEVER taken from a
 * model's recollection of the book — only from similarity to the pages the admin actually uploaded.
 *
 * All numeric thresholds are UNCALIBRATED defaults; tune them on photos of the real textbook (B6/D4).
 */

export interface PageCandidate {
  pageNumber: number;
  printedLabel: string | null;
  lessonId: string | null;
  lessonTitle: string | null;
  vectorSimilarity: number;   // cosine, 0..1
  trigramSimilarity: number;  // pg_trgm word_similarity(query, page), 0..1
  lexicalScore: number;       // ts_rank_cd
}

export interface Observation {
  printedPageNumber: string | null;
  textChars: number;          // normalised OCR characters
  legibility: "good" | "fair" | "poor";
}

export interface ScoredCandidate extends PageCandidate {
  score: number;              // 0..1
  printedNumberMatch: boolean;
}

export type MatchDecision = "confident" | "ambiguous" | "none";
export interface MatchResult {
  decision: MatchDecision;
  confidence: number;
  candidates: ScoredCandidate[]; // top 3, best first
  reason: "ok" | "too_little_text" | "low_score" | "close_runner_up" | "poor_legibility" | "no_candidates";
}

export const MATCH_THRESHOLDS = {
  minChars: 40,
  confident: 0.72,
  confidentWithNumber: 0.55,
  ambiguous: 0.45,
  margin: 0.12,
  poorLegibilityPenalty: 0.1,
} as const;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

const digits = (s: string | null) => (s ? s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/\D/g, "") : "");

export function scoreCandidate(c: PageCandidate, obs: Observation): ScoredCandidate {
  const sem = clamp01((c.vectorSimilarity - 0.2) / 0.6);
  const lex = clamp01(c.lexicalScore * 5);
  let score = 0.45 * sem + 0.45 * clamp01(c.trigramSimilarity) + 0.1 * lex;
  const seen = digits(obs.printedPageNumber);
  const mine = digits(c.printedLabel);
  const printedNumberMatch = seen !== "" && mine !== "" && seen === mine;
  if (printedNumberMatch) score += 0.25;
  else if (seen !== "" && mine !== "" && seen !== mine) score -= 0.15; // the visible page number says otherwise
  return { ...c, score: clamp01(score), printedNumberMatch };
}

export function decideMatch(candidates: PageCandidate[], obs: Observation): MatchResult {
  const T = MATCH_THRESHOLDS;
  const scored = candidates.map((c) => scoreCandidate(c, obs)).sort((a, b) => b.score - a.score);
  const top3 = scored.slice(0, 3);
  if (obs.textChars < T.minChars) return { decision: "none", confidence: top3[0]?.score ?? 0, candidates: top3, reason: "too_little_text" };
  if (!scored.length) return { decision: "none", confidence: 0, candidates: [], reason: "no_candidates" };

  const penalty = obs.legibility === "poor" ? T.poorLegibilityPenalty : 0;
  const best = scored[0]!;
  const eff = best.score - penalty;
  const margin = best.score - (scored[1]?.score ?? 0);

  if (eff >= T.confident && margin >= T.margin) return { decision: "confident", confidence: best.score, candidates: top3, reason: "ok" };
  if (best.printedNumberMatch && eff >= T.confidentWithNumber && margin >= T.margin / 2) {
    return { decision: "confident", confidence: best.score, candidates: top3, reason: "ok" };
  }
  if (eff >= T.ambiguous) {
    const reason = eff >= T.confident ? "close_runner_up" : obs.legibility === "poor" ? "poor_legibility" : "close_runner_up";
    return { decision: "ambiguous", confidence: best.score, candidates: top3, reason };
  }
  return { decision: "none", confidence: best.score, candidates: top3, reason: obs.legibility === "poor" ? "poor_legibility" : "low_score" };
}
