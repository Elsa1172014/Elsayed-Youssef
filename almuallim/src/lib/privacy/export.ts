import type { SupabaseClient } from "@supabase/supabase-js";

/** Everything the platform stores about ONE student (service-role reads, always filtered by that student's id). */
export async function collectStudentData(admin: SupabaseClient, studentId: string) {
  const q = async (table: string, select: string, col = "student_id") => {
    const { data, error } = await admin.from(table).select(select).eq(col, studentId);
    if (error) throw new Error(`export ${table} failed: ${error.message}`);
    return data ?? [];
  };
  const [profile, classMemberships, sessions, events, assessments, responses, mastery, usage] = await Promise.all([
    q("profiles", "id, role, display_name, year_group, locale, consent_recorded_at, allow_transcript_retention, created_at", "id"),
    q("class_members", "class_id, added_at"),
    q("tutoring_sessions", "id, mode, level, book_version_id, lesson_id, current_page, objective, channel, status, started_at, ended_at"),
    q("session_events", "session_id, seq, type, payload, sources, created_at"),
    q("assessments", "id, session_id, lesson_id, kind, objective, authored_by, created_at"),
    q("student_responses", "id, assessment_item_id, session_id, response_text, hints_used, ai_score, ai_rubric, ai_feedback, ai_misconception, teacher_score, teacher_feedback, teacher_validated_at, created_at"),
    q("skill_mastery", "skill, lesson_id, ai_estimate, teacher_validated, evidence_count, updated_at"),
    q("usage_ledger", "kind, amount, created_at", "user_id"),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    notice: "AI estimates (ai_*, ai_estimate) are automatic approximations, not grades. Teacher-validated values are marked teacher_*.",
    profile: profile[0] ?? null,
    classMemberships, sessions, events, assessments, responses, mastery, usage,
  };
}

/** Delete a student's learning records but keep the account. */
export async function deleteLearningData(admin: SupabaseClient, studentId: string) {
  for (const table of ["student_responses", "assessments", "skill_mastery", "tutoring_sessions", "usage_ledger"] as const) {
    const col = table === "usage_ledger" ? "user_id" : "student_id";
    const { error } = await admin.from(table).delete().eq(col, studentId);
    if (error) throw new Error(`delete ${table} failed: ${error.message}`);
  }
}
