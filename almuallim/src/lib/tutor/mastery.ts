import type { Level, Skill } from "./types";

export type Outcome = "correct" | "partial" | "incorrect";
export interface MasteryState {
  estimate: number; // 0..1 AI estimate (NOT a grade)
  evidence: number;
}

const BASE: Record<Outcome, number> = { correct: 1, partial: 0.5, incorrect: 0 };

/** Score of one piece of evidence; each hint used costs 15% (max 3 counted). */
export function evidenceScore(outcome: Outcome, hintsUsed: number): number {
  return BASE[outcome] * (1 - 0.15 * Math.min(Math.max(hintsUsed, 0), 3));
}

/** Learning-rate decays with evidence so early answers move the estimate fast and later ones stabilise it. */
export function updateMastery(prev: MasteryState | undefined, outcome: Outcome, hintsUsed = 0): MasteryState {
  const p = prev ?? { estimate: 0.5, evidence: 0 };
  const alpha = Math.max(0.15, 1 / (p.evidence + 2));
  const next = p.estimate + alpha * (evidenceScore(outcome, hintsUsed) - p.estimate);
  return { estimate: Math.round(Math.min(1, Math.max(0, next)) * 1000) / 1000, evidence: p.evidence + 1 };
}

/** Pick the challenge level from the AI estimate; with little evidence stay at "core". */
export function chooseLevel(m: MasteryState | undefined): Level {
  if (!m || m.evidence < 3) return "core";
  if (m.estimate < 0.4) return "support";
  if (m.estimate > 0.78) return "challenge";
  return "core";
}

export function describeMastery(mastery: Partial<Record<Skill, MasteryState>>): string {
  const AR: Record<Skill, string> = { grammar: "النحو", vocabulary: "المفردات", rhetoric: "البلاغة", comprehension: "الفهم القرائي", writing: "الكتابة", reading_aloud: "القراءة الجهرية" };
  const lines = Object.entries(mastery)
    .filter(([, m]) => m && m.evidence > 0)
    .map(([k, m]) => `- ${AR[k as Skill]}: ${Math.round(m!.estimate * 100)}٪ تقريبًا (من ${m!.evidence} إجابة)`);
  return lines.length ? lines.join("\n") : "لا توجد بيانات كافية بعد؛ ابدأ بمستوى متوسط وراقب إجابات الطالب.";
}
