import { describe, expect, it } from "vitest";
import { decideMatch, MATCH_THRESHOLDS, type Observation, type PageCandidate } from "@/lib/vision/page-match";

const cand = (pageNumber: number, o: Partial<PageCandidate> = {}): PageCandidate => ({
  pageNumber, printedLabel: String(pageNumber), lessonId: "l", lessonTitle: "درس", vectorSimilarity: 0.3, trigramSimilarity: 0.1, lexicalScore: 0, ...o,
});
const obs = (o: Partial<Observation> = {}): Observation => ({ printedPageNumber: null, textChars: 400, legibility: "good", ...o });
const strong = { vectorSimilarity: 0.8, trigramSimilarity: 0.95, lexicalScore: 0.3 };

describe("decideMatch", () => {
  it("confident when one page clearly dominates", () => {
    const r = decideMatch([cand(4, strong), cand(5), cand(2)], obs());
    expect(r.decision).toBe("confident");
    expect(r.candidates[0]!.pageNumber).toBe(4);
    expect(r.confidence).toBeGreaterThan(MATCH_THRESHOLDS.confident);
    expect(r.candidates).toHaveLength(3);
  });

  it("ambiguous when two pages are nearly as good (e.g. same lesson, similar text)", () => {
    const r = decideMatch([cand(4, strong), cand(5, { vectorSimilarity: 0.78, trigramSimilarity: 0.93, lexicalScore: 0.3 })], obs());
    expect(r.decision).toBe("ambiguous");
    expect(r.reason).toBe("close_runner_up");
    expect(r.candidates.map((c) => c.pageNumber)).toEqual([4, 5]);
  });

  it("the visible printed page number resolves otherwise-ambiguous candidates", () => {
    const close = [cand(4, strong), cand(5, { vectorSimilarity: 0.79, trigramSimilarity: 0.94, lexicalScore: 0.3 })];
    const r = decideMatch(close, obs({ printedPageNumber: "٥" }));
    expect(r.decision).toBe("confident");
    expect(r.candidates[0]!.pageNumber).toBe(5);
    expect(r.candidates[0]!.printedNumberMatch).toBe(true);
  });

  it("a conflicting printed number demotes a text-similar page and can flip a close call", () => {
    const pair = [cand(4, { vectorSimilarity: 0.6, trigramSimilarity: 0.8 }), cand(9, { vectorSimilarity: 0.55, trigramSimilarity: 0.7 })];
    expect(decideMatch(pair, obs()).candidates[0]!.pageNumber).toBe(4);
    const withNumber = decideMatch(pair, obs({ printedPageNumber: "9" }));
    expect(withNumber.candidates[0]!.pageNumber).toBe(9);
    // overwhelming text evidence still beats a misread number, but is penalised
    const strongText = decideMatch([cand(4, strong), cand(9, { vectorSimilarity: 0.5, trigramSimilarity: 0.6 })], obs({ printedPageNumber: "9" }));
    expect(strongText.candidates.find((c) => c.pageNumber === 4)!.score).toBeLessThan(decideMatch([cand(4, strong)], obs()).candidates[0]!.score);
  });

  it("none when there is too little text, regardless of candidates", () => {
    const r = decideMatch([cand(4, strong)], obs({ textChars: 10 }));
    expect(r.decision).toBe("none");
    expect(r.reason).toBe("too_little_text");
  });

  it("none for weak similarity (page not in the book)", () => {
    const r = decideMatch([cand(1), cand(2), cand(3)], obs());
    expect(r.decision).toBe("none");
    expect(r.reason).toBe("low_score");
  });

  it("no candidates → none", () => expect(decideMatch([], obs()).reason).toBe("no_candidates"));

  it("poor legibility lowers certainty: a borderline-confident match becomes ambiguous", () => {
    const borderline = [cand(4, { vectorSimilarity: 0.62, trigramSimilarity: 0.8, lexicalScore: 0.1 }), cand(5)];
    expect(decideMatch(borderline, obs({ legibility: "good" })).decision).toBe("confident");
    expect(decideMatch(borderline, obs({ legibility: "poor" })).decision).not.toBe("confident");
  });

  it("scores stay within [0,1]", () => {
    const r = decideMatch([cand(4, { vectorSimilarity: 2, trigramSimilarity: 2, lexicalScore: 99 })], obs({ printedPageNumber: "4" }));
    expect(r.candidates[0]!.score).toBeLessThanOrEqual(1);
  });
});
