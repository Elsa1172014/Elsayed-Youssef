import { randomBytes } from "node:crypto";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/guard";
import { apiError, json, parseBody } from "@/lib/http";
import { logger } from "@/lib/logger";
import { createUserSchema } from "@/lib/schemas/admin";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Admin provisions school-managed accounts (there is no public sign-up for minors). Returns a one-time temporary
 * password to hand to the user. Data minimisation: only email (required by auth), display name and year group.
 * Use pseudonymous school emails for students where possible.
 */
export async function POST(req: Request) {
  const a = await authorize(["admin"]);
  if (!a.ok) return a.response;
  const body = await parseBody(req, createUserSchema);
  if (!body.ok) return body.response;
  const i = body.data;
  if (i.role === "student" && !i.yearGroup) return apiError("invalid_input", "حدّد الصف الدراسي للطالب");

  const admin = createSupabaseAdmin();
  const password = randomBytes(12).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({
    email: i.email, password, email_confirm: true, user_metadata: { display_name: i.displayName },
  });
  if (error || !data.user) {
    logger.warn("user create failed", { code: error?.status });
    return apiError(error?.status === 422 ? "conflict" : "internal", error?.status === 422 ? "البريد مسجّل مسبقًا" : "تعذّر إنشاء الحساب");
  }
  const uid = data.user.id;
  // The signup trigger created a 'student' profile; elevate/complete it with the service role.
  const { error: upErr } = await admin.from("profiles").update({
    role: i.role, display_name: i.displayName, year_group: i.role === "student" ? i.yearGroup : null,
    consent_recorded_at: i.consentRecorded ? new Date().toISOString() : null,
  }).eq("id", uid);
  if (upErr) {
    await admin.auth.admin.deleteUser(uid);
    return apiError("internal", "تعذّر إعداد الملف الشخصي");
  }
  if (i.classId && i.role === "student") await admin.from("class_members").insert({ class_id: i.classId, student_id: uid });
  await audit(admin, { actorId: a.auth.profile.id, action: "user.create", targetType: "user", targetId: uid, metadata: { role: i.role, classId: i.classId } });
  return json({ userId: uid, temporaryPassword: password }, { status: 201 });
}
