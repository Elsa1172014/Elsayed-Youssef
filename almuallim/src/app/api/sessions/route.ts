import { authorize } from "@/lib/auth/guard";
import { apiError, json, parseBody } from "@/lib/http";
import { createSessionSchema } from "@/lib/schemas/tutor";

/** Start a tutoring session for the signed-in user. RLS guarantees the row belongs to them. */
export async function POST(req: Request) {
  const a = await authorize(["student", "teacher", "admin"]);
  if (!a.ok) return a.response;
  const body = await parseBody(req, createSessionSchema);
  if (!body.ok) return body.response;
  const { db, profile } = a.auth;
  const input = body.data;

  if (input.versionId) {
    // Visible only if READY (students) — RLS does the filtering.
    const { data: v } = await db.from("book_versions").select("id").eq("id", input.versionId).single();
    if (!v) return apiError("not_found", "الكتاب غير متاح");
    if (input.lessonId) {
      const { data: l } = await db.from("lessons").select("id").eq("id", input.lessonId).eq("book_version_id", input.versionId).single();
      if (!l) return apiError("invalid_input", "الدرس لا يتبع هذا الكتاب");
    }
  } else if (input.lessonId) {
    return apiError("invalid_input", "حدّد الكتاب مع الدرس");
  }

  const { data, error } = await db
    .from("tutoring_sessions")
    .insert({
      student_id: profile.id, mode: input.mode, level: input.level, book_version_id: input.versionId,
      lesson_id: input.lessonId, objective: input.objective, channel: input.channel,
    })
    .select("id, mode, level, book_version_id, lesson_id, current_page, channel, started_at")
    .single();
  if (error || !data) return apiError("internal", "تعذّر بدء الجلسة");
  return json({ session: data }, { status: 201 });
}
