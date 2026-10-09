import { authorize } from "@/lib/auth/guard";
import { apiError, json, parseBody } from "@/lib/http";
import { patchSessionSchema } from "@/lib/schemas/tutor";
import { uuidSchema } from "@/lib/schemas/admin";

/** Change mode/level or end a session (owner only, enforced by RLS). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await authorize(["student", "teacher", "admin"]);
  if (!a.ok) return a.response;
  const id = uuidSchema.safeParse((await ctx.params).id);
  if (!id.success) return apiError("invalid_input", "معرّف غير صالح");
  const body = await parseBody(req, patchSessionSchema);
  if (!body.ok) return body.response;
  const patch: Record<string, unknown> = {};
  if (body.data.mode) patch.mode = body.data.mode;
  if (body.data.level) patch.level = body.data.level;
  if (body.data.status === "ended") Object.assign(patch, { status: "ended", ended_at: new Date().toISOString() });
  if (!Object.keys(patch).length) return apiError("invalid_input", "لا توجد تغييرات");
  const { data, error } = await a.auth.db.from("tutoring_sessions").update(patch).eq("id", id.data).eq("student_id", a.auth.profile.id).select("id, mode, level, status").single();
  if (error || !data) return apiError("not_found", "الجلسة غير موجودة");
  return json({ session: data });
}
