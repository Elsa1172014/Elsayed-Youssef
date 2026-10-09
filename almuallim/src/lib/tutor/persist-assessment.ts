import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssessmentPersistence, RubricItem } from "./tool-core";
import type { Skill, TutorContext } from "./types";

/**
 * Practice/assessment storage for one tutoring session.
 *  - questions/items are written AS THE STUDENT (row-level security applies);
 *  - the AI-estimated score is written with the service role (students can never set scores — a DB trigger enforces it).
 */
export function createAssessmentPersistence(deps: { db: SupabaseClient; admin: SupabaseClient; ctx: TutorContext }): AssessmentPersistence {
  const { db, admin, ctx } = deps;
  const kind = ctx.mode === "assessment" ? "assessment" : "practice";

  async function assessmentId(): Promise<string> {
    const { data: existing } = await db
      .from("assessments").select("id").eq("session_id", ctx.sessionId).eq("student_id", ctx.studentId).eq("kind", kind).maybeSingle();
    if (existing) return (existing as { id: string }).id;
    const { data, error } = await db
      .from("assessments")
      .insert({ student_id: ctx.studentId, session_id: ctx.sessionId, lesson_id: ctx.lessonId, kind, objective: ctx.objective, authored_by: "ai" })
      .select("id").single();
    if (error || !data) throw new Error(`assessment insert failed: ${error?.message}`);
    return (data as { id: string }).id;
  }

  return {
    async createItem(i) {
      const aid = await assessmentId();
      const { data: last } = await db.from("assessment_items").select("ordinal").eq("assessment_id", aid).order("ordinal", { ascending: false }).limit(1).maybeSingle();
      const ordinal = ((last as { ordinal: number } | null)?.ordinal ?? -1) + 1;
      const { data, error } = await db
        .from("assessment_items")
        .insert({
          assessment_id: aid, ordinal, skill: i.skill, level: i.level, prompt: i.prompt,
          rubric: i.rubric.map((r) => ({ criterion: r.criterion, max_points: r.maxPoints })), hints: i.hints, source_chunk_ids: i.sourceChunkIds,
        })
        .select("id").single();
      if (error || !data) throw new Error(`item insert failed: ${error?.message}`);
      return { itemId: (data as { id: string }).id, ordinal };
    },

    async getItem(itemId) {
      const { data } = await db.from("assessment_items").select("id, skill, rubric, assessments(session_id, student_id)").eq("id", itemId).single();
      if (!data) return null;
      const row = data as { id: string; skill: Skill; rubric: { criterion: string; max_points: number }[]; assessments: { session_id: string | null; student_id: string } | { session_id: string | null; student_id: string }[] | null };
      const a = Array.isArray(row.assessments) ? row.assessments[0] : row.assessments;
      if (!a || a.student_id !== ctx.studentId) return null;
      const rubric: RubricItem[] = row.rubric.map((r) => ({ criterion: r.criterion, maxPoints: r.max_points }));
      return { id: row.id, skill: row.skill, rubric, sessionId: a.session_id };
    },

    async saveResponse(r) {
      const { data, error } = await admin
        .from("student_responses")
        .insert({
          assessment_item_id: r.itemId, student_id: ctx.studentId, session_id: ctx.sessionId, response_text: r.responseText,
          hints_used: r.hintsUsed, ai_score: r.aiScore, ai_rubric: r.aiRubric, ai_feedback: r.aiFeedback,
          ai_misconception: r.misconception, ai_scored_at: new Date().toISOString(),
        })
        .select("id").single();
      if (error || !data) throw new Error(`response insert failed: ${error?.message}`);
      return { responseId: (data as { id: string }).id };
    },
  };
}
