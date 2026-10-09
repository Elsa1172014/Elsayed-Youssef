import { describe, expect, it } from "vitest";
import { quoteIsFromChunk, verifyAnswer, type TutorAnswer } from "@/lib/tutor/answer";
import { chooseLevel, evidenceScore, updateMastery } from "@/lib/tutor/mastery";
import type { Passage } from "@/lib/retrieval/grounding";

const chunk: Passage = {
  chunkId: "c1", lessonId: "l1", lessonTitle: "الدرس الأول: الفاعل", pageStart: 2, pageEnd: 3,
  content: "الفاعل اسم مرفوع يدل على من قام بالفعل أو اتصف به، ويأتي بعد الفعل مباشرة.",
  vectorSimilarity: 0.6, lexicalScore: 0.2, fusedScore: 0.03,
};
const answer = (segments: TutorAnswer["segments"], over: Partial<TutorAnswer> = {}): TutorAnswer => ({
  segments, grounding: "grounded", completesExerciseForStudent: false, detectedMisconception: null, suggestedNextStep: null, ...over,
});

describe("quoteIsFromChunk", () => {
  it("accepts verbatim text, ignoring diacritics/punctuation differences", () => {
    expect(quoteIsFromChunk("الفَاعِلُ اسم مرفوع", chunk.content)).toBe(true);
    expect(quoteIsFromChunk("يدل على من قام بالفعل … ويأتي بعد الفعل", chunk.content)).toBe(true);
  });
  it("rejects invented, reordered, over-long or trivial quotes", () => {
    expect(quoteIsFromChunk("الفاعل اسم منصوب دائمًا", chunk.content)).toBe(false);
    expect(quoteIsFromChunk("مباشرة ويأتي بعد", chunk.content)).toBe(false);
    expect(quoteIsFromChunk("ال", chunk.content)).toBe(false);
    expect(quoteIsFromChunk("الفاعل ".repeat(200), chunk.content)).toBe(false);
  });
});

describe("verifyAnswer", () => {
  it("keeps a verbatim quote with a page citation and stays grounded", () => {
    const v = verifyAnswer(answer([{ kind: "quote", chunkId: "c1", text: "الفاعل اسم مرفوع" }, { kind: "explanation", text: "أي أنه يأخذ الضمة غالبًا." }]), [chunk], "strong");
    expect(v.grounding).toBe("grounded");
    expect(v.droppedQuotes).toBe(0);
    expect(v.segments[0]).toMatchObject({ kind: "quote", source: { label: "ص ٢–٣", lessonTitle: "الدرس الأول: الفاعل" } });
    expect(v.sources).toHaveLength(1);
  });
  it("drops fabricated quotes, quotes citing unknown chunks, and downgrades a claim of grounding it cannot back", () => {
    const v = verifyAnswer(
      answer([{ kind: "quote", chunkId: "c1", text: "الفاعل اسم منصوب دائمًا في كل الأحوال" }, { kind: "quote", chunkId: "ghost", text: "الفاعل اسم مرفوع" }, { kind: "explanation", text: "شرح" }]),
      [chunk], "strong");
    expect(v.droppedQuotes).toBe(2);
    expect(v.grounding).toBe("partial");
    expect(v.segments[0]!.kind).toBe("notice");
    expect(v.sources).toHaveLength(0);
  });
  it("caps grounding by retrieval: weak → partial, none/empty → ungrounded with a visible notice", () => {
    const q = answer([{ kind: "quote", chunkId: "c1", text: "الفاعل اسم مرفوع" }]);
    expect(verifyAnswer(q, [chunk], "weak").grounding).toBe("partial");
    const none = verifyAnswer(answer([{ kind: "explanation", text: "x" }], { grounding: "grounded" }), [], "none");
    expect(none.grounding).toBe("ungrounded");
    expect(none.segments[0]).toMatchObject({ kind: "notice" });
    expect((none.segments[0] as { text: string }).text).toContain("لم أجد");
  });
  it("a model-declared ungrounded answer stays ungrounded even when retrieval is strong", () => {
    expect(verifyAnswer(answer([{ kind: "explanation", text: "x" }], { grounding: "ungrounded" }), [chunk], "strong").grounding).toBe("ungrounded");
  });
});

describe("mastery model", () => {
  it("moves toward evidence, fast at first, slower later; hints reduce credit", () => {
    const a = updateMastery(undefined, "correct");
    expect(a.estimate).toBeGreaterThan(0.5);
    const b = updateMastery({ estimate: 0.5, evidence: 20 }, "correct");
    expect(b.estimate - 0.5).toBeLessThan(a.estimate - 0.5);
    expect(evidenceScore("correct", 3)).toBeCloseTo(0.55);
    expect(updateMastery({ estimate: 0.5, evidence: 5 }, "correct", 3).estimate).toBeLessThan(updateMastery({ estimate: 0.5, evidence: 5 }, "correct", 0).estimate);
  });
  it("stays within [0,1] and counts evidence", () => {
    let m = updateMastery(undefined, "incorrect");
    for (let i = 0; i < 30; i++) m = updateMastery(m, "incorrect");
    expect(m.estimate).toBeGreaterThanOrEqual(0);
    expect(m.evidence).toBe(31);
  });
  it("chooses level conservatively with little evidence", () => {
    expect(chooseLevel(undefined)).toBe("core");
    expect(chooseLevel({ estimate: 0.1, evidence: 2 })).toBe("core");
    expect(chooseLevel({ estimate: 0.2, evidence: 6 })).toBe("support");
    expect(chooseLevel({ estimate: 0.9, evidence: 6 })).toBe("challenge");
    expect(chooseLevel({ estimate: 0.6, evidence: 6 })).toBe("core");
  });
});
