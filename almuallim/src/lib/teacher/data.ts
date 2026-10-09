import type { SupabaseClient } from "@supabase/supabase-js";
import { analyzeStudent, summarizeClass, type MasteryInput, type ResponseInput, type StudentOverview } from "@/lib/analytics/student";
import type { Skill } from "@/lib/tutor/types";

/** All reads run as the signed-in teacher/admin, so row-level security decides which students are visible. */

interface MasteryRow { student_id: string; skill: Skill; lesson_id: string | null; ai_estimate: number; teacher_validated: number | null; evidence_count: number }
interface RespRow { id: string; student_id: string; ai_score: number | null; teacher_score: number | null; hints_used: number; ai_misconception: string | null; created_at: string; assessment_items: { skill: Skill } | { skill: Skill }[] | null }

const one = <T,>(x: T | T[] | null): T | null => (Array.isArray(x) ? (x[0] ?? null) : x);
const toMastery = (r: MasteryRow): MasteryInput => ({ skill: r.skill, lessonId: r.lesson_id, aiEstimate: Number(r.ai_estimate), teacherValidated: r.teacher_validated == null ? null : Number(r.teacher_validated), evidence: r.evidence_count });
const toResponse = (r: RespRow): ResponseInput => ({
  skill: one(r.assessment_items)?.skill ?? null, aiScore: r.ai_score == null ? null : Number(r.ai_score), teacherScore: r.teacher_score == null ? null : Number(r.teacher_score),
  hintsUsed: r.hints_used, misconception: r.ai_misconception, createdAt: r.created_at,
});

export interface ClassOverview { id: string; name: string; yearGroup: number; students: StudentOverview[] }

export async function loadTeacherOverview(db: SupabaseClient): Promise<ClassOverview[]> {
  const { data: classes } = await db.from("classes").select("id, name, year_group").order("name");
  if (!classes?.length) return [];
  const { data: members } = await db.from("class_members").select("class_id, student_id").in("class_id", classes.map((c) => c.id));
  const studentIds = [...new Set((members ?? []).map((m) => m.student_id as string))];
  if (!studentIds.length) return classes.map((c) => ({ id: c.id, name: c.name, yearGroup: c.year_group, students: [] }));

  const [{ data: profiles }, { data: mastery }, { data: responses }, { data: sessions }] = await Promise.all([
    db.from("profiles").select("id, display_name, year_group").in("id", studentIds),
    db.from("skill_mastery").select("student_id, skill, lesson_id, ai_estimate, teacher_validated, evidence_count").in("student_id", studentIds),
    db.from("student_responses").select("id, student_id, ai_score, teacher_score, hints_used, ai_misconception, created_at, assessment_items(skill)").in("student_id", studentIds).order("created_at", { ascending: false }).limit(2000),
    db.from("tutoring_sessions").select("student_id, started_at").in("student_id", studentIds).order("started_at", { ascending: false }).limit(5000),
  ]);

  return classes.map((c) => {
    const ids = new Set((members ?? []).filter((m) => m.class_id === c.id).map((m) => m.student_id as string));
    const students = (profiles ?? []).filter((p) => ids.has(p.id)).map((p) => {
      const ss = (sessions ?? []).filter((s) => s.student_id === p.id);
      return {
        id: p.id, displayName: p.display_name || "طالب", yearGroup: p.year_group,
        mastery: ((mastery ?? []) as MasteryRow[]).filter((x) => x.student_id === p.id).map(toMastery),
        responses: ((responses ?? []) as RespRow[]).filter((x) => x.student_id === p.id).map(toResponse),
        sessions: ss.length, lastActive: (ss[0]?.started_at as string | undefined) ?? null,
      };
    });
    return { id: c.id, name: c.name, yearGroup: c.year_group, students: summarizeClass(students) };
  });
}

export interface ResponseDetail {
  id: string; createdAt: string; skill: Skill | null; prompt: string | null; answer: string; hintsUsed: number;
  aiScore: number | null; aiFeedback: string | null; aiMisconception: string | null;
  teacherScore: number | null; teacherFeedback: string | null; validated: boolean;
}
export interface StudentDetail {
  profile: { id: string; displayName: string; yearGroup: number | null };
  analysis: ReturnType<typeof analyzeStudent>;
  responses: ResponseDetail[];
  sessions: { id: string; mode: string; startedAt: string; endedAt: string | null; channel: string; currentPage: number | null }[];
  sourcePages: { lesson: string | null; pages: string; count: number }[];
}

export async function loadStudentDetail(db: SupabaseClient, studentId: string): Promise<StudentDetail | null> {
  const { data: profile } = await db.from("profiles").select("id, display_name, year_group").eq("id", studentId).single();
  if (!profile) return null; // not visible under RLS (not this teacher's student) or does not exist
  const [{ data: mastery }, { data: resp }, { data: sessions }, { data: events }] = await Promise.all([
    db.from("skill_mastery").select("student_id, skill, lesson_id, ai_estimate, teacher_validated, evidence_count").eq("student_id", studentId),
    db.from("student_responses")
      .select("id, student_id, ai_score, teacher_score, hints_used, ai_misconception, created_at, response_text, ai_feedback, teacher_feedback, teacher_validated_at, assessment_items(skill, prompt)")
      .eq("student_id", studentId).order("created_at", { ascending: false }).limit(60),
    db.from("tutoring_sessions").select("id, mode, started_at, ended_at, channel, current_page").eq("student_id", studentId).order("started_at", { ascending: false }).limit(20),
    db.from("session_events").select("sources").eq("student_id", studentId).in("type", ["assistant_text"]).order("created_at", { ascending: false }).limit(60),
  ]);
  interface Full extends Omit<RespRow, "assessment_items"> { response_text: string; ai_feedback: string | null; teacher_feedback: string | null; teacher_validated_at: string | null; assessment_items: { skill: Skill; prompt: string } | { skill: Skill; prompt: string }[] | null }
  const rows = (resp ?? []) as unknown as Full[];

  const refs = new Map<string, { lesson: string | null; pages: string; count: number }>();
  for (const e of events ?? []) {
    for (const s of (e.sources as { lesson?: string | null; pageStart: number; pageEnd: number }[] | null) ?? []) {
      const pages = s.pageStart === s.pageEnd ? `${s.pageStart}` : `${s.pageStart}–${s.pageEnd}`;
      const key = `${s.lesson ?? ""}|${pages}`;
      refs.set(key, { lesson: s.lesson ?? null, pages, count: (refs.get(key)?.count ?? 0) + 1 });
    }
  }

  return {
    profile: { id: profile.id, displayName: profile.display_name || "طالب", yearGroup: profile.year_group },
    analysis: analyzeStudent(((mastery ?? []) as MasteryRow[]).map(toMastery), rows.map((r) => toResponse(r as unknown as RespRow))),
    responses: rows.map((r) => {
      const item = one(r.assessment_items);
      return {
        id: r.id, createdAt: r.created_at, skill: item?.skill ?? null, prompt: item?.prompt ?? null, answer: r.response_text, hintsUsed: r.hints_used,
        aiScore: r.ai_score == null ? null : Number(r.ai_score), aiFeedback: r.ai_feedback, aiMisconception: r.ai_misconception,
        teacherScore: r.teacher_score == null ? null : Number(r.teacher_score), teacherFeedback: r.teacher_feedback, validated: !!r.teacher_validated_at,
      };
    }),
    sessions: (sessions ?? []).map((s) => ({ id: s.id, mode: s.mode, startedAt: s.started_at, endedAt: s.ended_at, channel: s.channel, currentPage: s.current_page })),
    sourcePages: [...refs.values()].sort((a, b) => b.count - a.count).slice(0, 10),
  };
}
