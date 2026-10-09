import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/guard";
import { apiError, json, parseBody } from "@/lib/http";
import { validateMasterySchema } from "@/lib/schemas/admin";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Set (or clear) the teacher-validated mastery value for one skill. The relationship check runs under the
 * teacher's RLS (a teacher only "sees" their own students); the write uses the service role because a student
 * may not yet have a mastery row and users cannot insert them.
 */
export async function PUT(req: Request) {
  const a = await authorize(["teacher", "admin"]);
  if (!a.ok) return a.response;
  const body = await parseBody(req, validateMasterySchema);
  if (!body.ok) return body.response;
  const { studentId, skill, lessonId, value } = body.data;

  const { data: visible } = await a.auth.db.from("profiles").select("id").eq("id", studentId).single();
  if (!visible) return apiError("not_found", "الطالب غير موجود أو ليس ضمن صفوفك");

  const admin = createSupabaseAdmin();
  let q = admin.from("skill_mastery").select("id").eq("student_id", studentId).eq("skill", skill);
  q = lessonId ? q.eq("lesson_id", lessonId) : q.is("lesson_id", null);
  const { data: existing } = await q.maybeSingle();
  const stamp = { teacher_validated: value, updated_at: new Date().toISOString() };
  const { error } = existing
    ? await admin.from("skill_mastery").update(stamp).eq("id", (existing as { id: string }).id)
    : await admin.from("skill_mastery").insert({ student_id: studentId, skill, lesson_id: lessonId, ai_estimate: 0, evidence_count: 0, ...stamp });
  if (error) return apiError("internal", "تعذّر حفظ الاعتماد");
  await audit(admin, { actorId: a.auth.profile.id, action: "mastery.validate", targetType: "student", targetId: studentId, metadata: { skill, lessonId, value } });
  return json({ ok: true });
}
