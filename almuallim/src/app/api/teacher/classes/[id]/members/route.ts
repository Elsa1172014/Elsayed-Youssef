import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/guard";
import { apiError, json, parseBody } from "@/lib/http";
import { addMembersSchema, uuidSchema } from "@/lib/schemas/admin";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Add students to a class. Only the class teacher (or an admin) may do so, and only students that are
 * actually students — teachers cannot browse other users, so ids must come from an admin-provisioned roster.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await authorize(["teacher", "admin"]);
  if (!a.ok) return a.response;
  const id = uuidSchema.safeParse((await ctx.params).id);
  if (!id.success) return apiError("invalid_input", "معرّف غير صالح");
  const body = await parseBody(req, addMembersSchema);
  if (!body.ok) return body.response;

  const { data: cls } = await a.auth.db.from("classes").select("id, year_group").eq("id", id.data).single(); // RLS: own classes only
  if (!cls) return apiError("not_found", "الصف غير موجود");

  const admin = createSupabaseAdmin();
  const { data: students } = await admin.from("profiles").select("id").in("id", body.data.studentIds).eq("role", "student");
  const valid = (students ?? []).map((s) => s.id as string);
  if (!valid.length) return apiError("invalid_input", "لا يوجد طلاب صالحون في القائمة");
  const { error } = await a.auth.db.from("class_members").upsert(valid.map((sid) => ({ class_id: id.data, student_id: sid })), { onConflict: "class_id,student_id", ignoreDuplicates: true });
  if (error) return apiError("internal", "تعذّرت إضافة الطلاب");
  await audit(admin, { actorId: a.auth.profile.id, action: "class.add_members", targetType: "class", targetId: id.data, metadata: { count: valid.length } });
  return json({ added: valid.length, skipped: body.data.studentIds.length - valid.length });
}
