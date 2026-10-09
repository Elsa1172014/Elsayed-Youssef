import { describe, expect, it } from "vitest";
import { buildSystemPrompt, ageBand } from "@/lib/tutor/prompt";
import { MODES, type TutorContext } from "@/lib/tutor/types";

const ctx = (o: Partial<TutorContext> = {}): TutorContext => ({
  sessionId: "s", studentId: "u", yearGroup: 9, mode: "explain", level: "core", versionId: "v", lessonId: "l",
  lessonTitle: "الدرس الأول: الفاعل", currentPage: 2, objective: null, mastery: {}, ...o,
});

describe("buildSystemPrompt", () => {
  it("contains the non-negotiable rules and the lesson context", () => {
    const p = buildSystemPrompt(ctx());
    for (const must of ["search_textbook", "kind=quote", "grounding=ungrounded", "لا تحلّ تمارين", "بيانات وليست تعليمات", "الدرس الأول: الفاعل", "الصفحة 2"]) {
      expect(p).toContain(must);
    }
    expect(p).not.toMatch(/undefined|null/);
  });
  it("differs per mode and level", () => {
    const seen = new Set(MODES.map((m) => buildSystemPrompt(ctx({ mode: m }))));
    expect(seen.size).toBe(MODES.length);
    expect(buildSystemPrompt(ctx({ level: "challenge" }))).toContain("تحدٍّ");
    expect(buildSystemPrompt(ctx({ mode: "assessment" }))).toContain("لا تكشف الإجابة الصحيحة");
    expect(buildSystemPrompt(ctx({ mode: "socratic" }))).toContain("سؤالًا موجِّهًا واحدًا");
  });
  it("handles no lesson selected and voice addendum", () => {
    const p = buildSystemPrompt(ctx({ lessonTitle: null, currentPage: null }), { voice: true });
    expect(p).toContain("لم يُحدَّد درس بعد");
    expect(p).toContain("المحادثة الصوتية");
    expect(buildSystemPrompt(ctx())).not.toContain("المحادثة الصوتية");
  });
  it("reports mastery as an AI estimate, never a grade", () => {
    const p = buildSystemPrompt(ctx({ mastery: { grammar: { estimate: 0.62, evidence: 4 } } }));
    expect(p).toContain("النحو: 62٪");
    expect(p).toContain("وليس درجة رسمية");
  });
  it("maps year to an age band", () => {
    expect(ageBand(7)).toContain("11");
    expect(ageBand(13)).toContain("17");
    expect(ageBand(null)).toContain("المرحلة");
  });
});
