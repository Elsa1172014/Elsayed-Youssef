import { describe, expect, it } from "vitest";
import { analyzeStudent, summarizeClass, type MasteryInput, type ResponseInput } from "@/lib/analytics/student";

const m = (skill: MasteryInput["skill"], aiEstimate: number, evidence: number, teacherValidated: number | null = null, lessonId: string | null = null): MasteryInput => ({ skill, aiEstimate, teacherValidated, evidence, lessonId });
const r = (o: Partial<ResponseInput> = {}): ResponseInput => ({ skill: "grammar", aiScore: 50, teacherScore: null, hintsUsed: 0, misconception: null, createdAt: "2026-10-01T10:00:00Z", ...o });

describe("analyzeStudent", () => {
  it("never calls a skill a strength or gap on thin evidence", () => {
    const a = analyzeStudent([m("grammar", 0.1, 2), m("vocabulary", 0.95, 1)], []);
    expect(a.gaps).toEqual([]);
    expect(a.strengths).toEqual([]);
    expect(a.skills.find((s) => s.skill === "grammar")).toMatchObject({ status: "insufficient", statusBasis: "none", evidence: 2 });
  });

  it("classifies from the AI estimate once there is enough evidence, and says so", () => {
    const a = analyzeStudent([m("grammar", 0.3, 6), m("vocabulary", 0.9, 4), m("rhetoric", 0.6, 5)], []);
    expect(a.gaps).toEqual(["grammar"]);
    expect(a.strengths).toEqual(["vocabulary"]);
    expect(a.skills.find((s) => s.skill === "rhetoric")).toMatchObject({ status: "developing", statusBasis: "ai-estimate" });
    const gap = a.interventions.find((i) => i.priority === 1)!;
    expect(gap.text).toContain("النحو");
    expect(gap.basis).toContain("تقدير آلي");
    expect(gap.basis).toContain("يحتاج تأكيدك");
  });

  it("teacher validation overrides the AI estimate for status, and disagreements are flagged", () => {
    const a = analyzeStudent([m("grammar", 0.3, 6, 0.8)], []);
    const g = a.skills.find((s) => s.skill === "grammar")!;
    expect(g).toMatchObject({ status: "strength", statusBasis: "teacher", teacherValidated: 0.8, aiEstimate: 0.3 });
    expect(a.disagreements).toEqual(["grammar"]);
    expect(a.interventions.some((i) => i.text.includes("يختلف عن اعتمادك"))).toBe(true);
    // even with little AI evidence, a teacher-validated value counts
    expect(analyzeStudent([m("writing", 0, 0, 0.3)], []).gaps).toEqual(["writing"]);
  });

  it("weights per-lesson rows by evidence when aggregating a skill", () => {
    const a = analyzeStudent([m("grammar", 1, 1, null, "l1"), m("grammar", 0.4, 9, null, "l2")], []);
    expect(a.skills.find((s) => s.skill === "grammar")!.aiEstimate).toBeCloseTo(0.46, 2);
  });

  it("surfaces repeated misconceptions and hint dependence as interventions", () => {
    const rs = [r({ misconception: "خلط بين الفاعل والمفعول به", hintsUsed: 2 }), r({ misconception: "خلط بين الفاعل  والمفعول به", hintsUsed: 2, createdAt: "2026-10-05T10:00:00Z" }), r({ misconception: "نسيان تنوين الضم", hintsUsed: 1 })];
    const a = analyzeStudent([], rs);
    expect(a.misconceptions[0]).toMatchObject({ count: 2, lastSeen: "2026-10-05T10:00:00Z" });
    expect(a.misconceptions).toHaveLength(2);
    expect(a.hintDependence).toBeCloseTo(1.67, 2);
    const texts = a.interventions.map((i) => i.text).join("|");
    expect(texts).toContain("الفهم الخاطئ المتكرر");
    expect(texts).toContain("قلّل الاعتماد على التلميحات");
    expect(texts).not.toContain("نسيان تنوين الضم"); // a one-off is not escalated
  });

  it("with no data at all it asks for more practice instead of drawing conclusions", () => {
    const a = analyzeStudent([], []);
    expect(a.insufficient).toHaveLength(6);
    expect(a.interventions).toHaveLength(1);
    expect(a.interventions[0]!.basis).toBe("لا تتوفر بيانات");
    expect(a.hintDependence).toBeNull();
  });

  it("orders interventions by priority", () => {
    const a = analyzeStudent([m("grammar", 0.2, 6), m("vocabulary", 0.9, 5)], []);
    expect(a.interventions.map((i) => i.priority)).toEqual([...a.interventions.map((i) => i.priority)].sort());
  });
});

describe("summarizeClass", () => {
  const now = new Date("2026-10-20T00:00:00Z").getTime();
  const base = { yearGroup: 9, sessions: 2, responses: [] as ResponseInput[] };
  it("puts students needing support first, then inactive, no-data, ok", () => {
    const out = summarizeClass([
      { ...base, id: "ok", displayName: "هدى", mastery: [m("grammar", 0.7, 5)], lastActive: "2026-10-19T00:00:00Z" },
      { ...base, id: "none", displayName: "باسل", mastery: [], lastActive: null },
      { ...base, id: "gap", displayName: "زياد", mastery: [m("grammar", 0.2, 5)], lastActive: "2026-10-19T00:00:00Z" },
      { ...base, id: "inactive", displayName: "ليلى", mastery: [m("grammar", 0.7, 5)], lastActive: "2026-09-01T00:00:00Z" },
    ], now);
    expect(out.map((s) => [s.id, s.attention])).toEqual([["gap", "needs-support"], ["inactive", "inactive"], ["none", "no-data"], ["ok", "ok"]]);
    expect(out[0]!.gaps).toEqual(["grammar"]);
  });
});
