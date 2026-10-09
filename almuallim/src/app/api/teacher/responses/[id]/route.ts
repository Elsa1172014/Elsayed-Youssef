import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/guard";
import { apiError, json, parseBody } from "@/lib/http";
import { uuidSchema, validateResponseSchema } from "@/lib/schemas/admin";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Teacher validation of a student's response. Runs under the TEACHER's session: RLS limits it to their own
 * students and a DB trigger stamps the validator and refuses any change to the AI fields.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await authorize(["teacher", "admin"]);
  if (!a.ok) return a.response;
  const id = uuidSchema.safeParse((await ctx.params).id);
  if (!id.success) return apiError("invalid_input", "معرّف غير صالح");
  const body = await parseBody(req, validateResponseSchema);
  if (!body.ok) return body.response;

  const { data, error } = await a.auth.db
    .from("student_responses")
    .update({ teacher_score: body.data.teacherScore, teacher_feedback: body.data.teacherFeedback ?? null })
    .eq("id", id.data)
    .select("id, teacher_score, teacher_validated_at")
    .single();
  if (error || !data) return apiError("not_found", "الإجابة غير موجودة أو ليست لأحد طلابك");
  await audit(createSupabaseAdmin(), { actorId: a.auth.profile.id, action: "response.validate", targetType: "student_response", targetId: id.data, metadata: { score: body.data.teacherScore } });
  return json({ response: data });
}
