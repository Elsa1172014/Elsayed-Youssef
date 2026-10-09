import { SKILLS, type Skill } from "@/lib/tutor/types";

export const SKILL_LABEL_AR: Record<Skill, string> = {
  grammar: "النحو", vocabulary: "المفردات", rhetoric: "البلاغة", comprehension: "الفهم القرائي", writing: "الكتابة", reading_aloud: "القراءة الجهرية",
};

export interface MasteryInput { skill: Skill; lessonId: string | null; aiEstimate: number; teacherValidated: number | null; evidence: number }
export interface ResponseInput { skill: Skill | null; aiScore: number | null; teacherScore: number | null; hintsUsed: number; misconception: string | null; createdAt: string }

export type SkillStatus = "strength" | "developing" | "gap" | "insufficient";
export interface SkillSummary {
  skill: Skill;
  aiEstimate: number | null;          // AI estimate, evidence-weighted across lessons
  teacherValidated: number | null;    // authoritative when present
  evidence: number;
  status: SkillStatus;
  statusBasis: "teacher" | "ai-estimate" | "none"; // what the status is based on
}
export interface Intervention { priority: 1 | 2 | 3; text: string; basis: string }
export interface StudentAnalysis {
  skills: SkillSummary[];
  strengths: Skill[];
  gaps: Skill[];
  insufficient: Skill[];
  misconceptions: { text: string; count: number; lastSeen: string }[];
  hintDependence: number | null;      // mean hints per response
  disagreements: Skill[];             // |AI − teacher| > 0.2
  interventions: Intervention[];
}

export const MIN_EVIDENCE = 3;
export const STRENGTH_AT = 0.75;
export const GAP_AT = 0.45;

const pct = (x: number) => `${Math.round(x * 100)}٪`;

/** Rule-based, deterministic analysis. Everything derived from AI estimates is labelled as such; teacher validation wins. */
export function analyzeStudent(mastery: MasteryInput[], responses: ResponseInput[]): StudentAnalysis {
  const skills: SkillSummary[] = SKILLS.map((skill) => {
    const rows = mastery.filter((m) => m.skill === skill);
    const evidence = rows.reduce((n, r) => n + r.evidence, 0);
    const ai = evidence > 0 ? rows.reduce((n, r) => n + r.aiEstimate * r.evidence, 0) / evidence : null;
    const validated = rows.filter((r) => r.teacherValidated != null);
    const teacher = validated.length ? validated.reduce((n, r) => n + (r.teacherValidated as number), 0) / validated.length : null;

    let status: SkillStatus = "insufficient";
    let statusBasis: SkillSummary["statusBasis"] = "none";
    if (teacher != null) {
      statusBasis = "teacher";
      status = teacher >= STRENGTH_AT ? "strength" : teacher <= GAP_AT ? "gap" : "developing";
    } else if (ai != null && evidence >= MIN_EVIDENCE) {
      statusBasis = "ai-estimate";
      status = ai >= STRENGTH_AT ? "strength" : ai <= GAP_AT ? "gap" : "developing";
    }
    return { skill, aiEstimate: ai == null ? null : Math.round(ai * 1000) / 1000, teacherValidated: teacher == null ? null : Math.round(teacher * 1000) / 1000, evidence, status, statusBasis };
  });

  const strengths = skills.filter((s) => s.status === "strength").map((s) => s.skill);
  const gaps = skills.filter((s) => s.status === "gap").map((s) => s.skill);
  const insufficient = skills.filter((s) => s.status === "insufficient").map((s) => s.skill);
  const disagreements = skills.filter((s) => s.aiEstimate != null && s.teacherValidated != null && Math.abs(s.aiEstimate - s.teacherValidated) > 0.2).map((s) => s.skill);

  const mis = new Map<string, { text: string; count: number; lastSeen: string }>();
  for (const r of responses) {
    const t = r.misconception?.trim();
    if (!t) continue;
    const key = t.replace(/\s+/g, " ");
    const cur = mis.get(key);
    mis.set(key, { text: key, count: (cur?.count ?? 0) + 1, lastSeen: !cur || r.createdAt > cur.lastSeen ? r.createdAt : cur.lastSeen });
  }
  const misconceptions = [...mis.values()].sort((a, b) => b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : -1));
  const hintDependence = responses.length ? Math.round((responses.reduce((n, r) => n + r.hintsUsed, 0) / responses.length) * 100) / 100 : null;

  const interventions: Intervention[] = [];
  for (const s of skills.filter((x) => x.status === "gap")) {
    interventions.push({
      priority: 1,
      text: `جلسة تدريب قصيرة (١٥ دقيقة) على «${SKILL_LABEL_AR[s.skill]}» بمستوى «دعم» مع تلميحات متدرجة.`,
      basis: s.statusBasis === "teacher" ? `اعتماد المعلّم ${pct(s.teacherValidated!)}` : `تقدير آلي ${pct(s.aiEstimate!)} من ${s.evidence} إجابات — يحتاج تأكيدك`,
    });
  }
  for (const m of misconceptions.filter((x) => x.count >= 2).slice(0, 3)) {
    interventions.push({ priority: 1, text: `عالج الفهم الخاطئ المتكرر: «${m.text}» بمثال مضاد ثم تمرين تطبيقي.`, basis: `لاحظه المعلّم الآلي ${m.count} مرات` });
  }
  if (hintDependence != null && hintDependence >= 1.5 && responses.length >= 3) {
    interventions.push({ priority: 2, text: "قلّل الاعتماد على التلميحات: اطلب منه شرح خطوات الحل بصوته قبل أن يتلقى تلميحًا.", basis: `متوسط ${hintDependence} تلميحًا لكل إجابة` });
  }
  for (const k of disagreements) {
    interventions.push({ priority: 2, text: `تقدير الآلة في «${SKILL_LABEL_AR[k]}» يختلف عن اعتمادك؛ راجع إجاباته الأخيرة وحدّث الاعتماد.`, basis: "فرق يتجاوز ٢٠ نقطة مئوية" });
  }
  for (const k of strengths.slice(0, 2)) {
    interventions.push({ priority: 3, text: `قدّم أسئلة «تحدٍّ» في «${SKILL_LABEL_AR[k]}» (استنباط وتحليل) للحفاظ على الدافعية.`, basis: "نقطة قوة" });
  }
  if (insufficient.length === SKILLS.length) {
    interventions.push({ priority: 2, text: "لا توجد أدلة كافية بعد؛ شجّعه على إكمال ٣ تمارين على الأقل في كل مهارة قبل أي استنتاج.", basis: "لا تتوفر بيانات" });
  }
  interventions.sort((a, b) => a.priority - b.priority);

  return { skills, strengths, gaps, insufficient, misconceptions, hintDependence, disagreements, interventions };
}

// ───────────── class level ─────────────
export interface StudentSummaryInput { id: string; displayName: string; yearGroup: number | null; mastery: MasteryInput[]; responses: ResponseInput[]; sessions: number; lastActive: string | null; safetyFlags?: number }
export interface StudentOverview {
  id: string; displayName: string; yearGroup: number | null; sessions: number; lastActive: string | null; evidence: number;
  gaps: Skill[]; strengths: Skill[]; safetyFlags: number; attention: "safeguarding" | "needs-support" | "inactive" | "no-data" | "ok";
}
export const INACTIVE_DAYS = 14;

export function summarizeClass(students: StudentSummaryInput[], now = Date.now()): StudentOverview[] {
  return students
    .map((s) => {
      const a = analyzeStudent(s.mastery, s.responses);
      const evidence = a.skills.reduce((n, k) => n + k.evidence, 0);
      const inactive = s.lastActive ? now - new Date(s.lastActive).getTime() > INACTIVE_DAYS * 86400_000 : true;
      const flags = s.safetyFlags ?? 0;
      const attention: StudentOverview["attention"] = flags > 0 ? "safeguarding" : a.gaps.length ? "needs-support" : evidence === 0 ? "no-data" : inactive ? "inactive" : "ok";
      return { id: s.id, displayName: s.displayName, yearGroup: s.yearGroup, sessions: s.sessions, lastActive: s.lastActive, evidence, gaps: a.gaps, strengths: a.strengths, safetyFlags: flags, attention };
    })
    .sort((x, y) => RANK[x.attention] - RANK[y.attention] || x.displayName.localeCompare(y.displayName, "ar"));
}
const RANK = { safeguarding: -1, "needs-support": 0, inactive: 1, "no-data": 2, ok: 3 } as const;
