import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/guard";
import { apiError, json, parseBody } from "@/lib/http";
import { logger } from "@/lib/logger";
import { deleteLearningData } from "@/lib/privacy/export";
import { deleteDataSchema } from "@/lib/schemas/admin";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Deletion workflows.
 *  - a student may delete THEIR OWN learning records (sessions, transcripts, responses, mastery) at any time;
 *  - deleting an ACCOUNT is a school action (accounts are school-managed for minors) and is admin-only;
 *  - teachers cannot delete student data.
 * Audit rows keep only opaque ids (no content), which is what makes the deletion itself provable.
 */
export async function POST(req: Request) {
  const a = await authorize(["student", "admin"]);
  if (!a.ok) return a.response;
  const body = await parseBody(req, deleteDataSchema);
  if (!body.ok) return body.response;
  const { scope, studentId } = body.data;
  const isAdmin = a.auth.profile.role === "admin";
  const target = studentId ?? a.auth.profile.id;

  if (target !== a.auth.profile.id && !isAdmin) return apiError("forbidden", "لا يمكنك حذف بيانات مستخدم آخر");
  if (scope === "account" && !isAdmin) return apiError("forbidden", "حذف الحساب يتم عبر مسؤول المدرسة. يمكنك حذف سجلّ تعلّمك من هنا.");

  const admin = createSupabaseAdmin();
  try {
    if (scope === "learning_data") {
      await deleteLearningData(admin, target);
      await audit(admin, { actorId: a.auth.profile.id, action: "student.delete_learning_data", targetType: "user", targetId: target });
      return json({ deleted: "learning_data" });
    }
    const { error } = await admin.auth.admin.deleteUser(target);
    if (error) {
      logger.error("account delete failed", { status: error.status });
      return apiError("conflict", "تعذّر حذف الحساب (قد يكون مرتبطًا بصفوف). أزل الارتباطات أولًا.");
    }
    await audit(admin, { actorId: a.auth.profile.id, action: "student.delete_account", targetType: "user", targetId: target });
    return json({ deleted: "account" });
  } catch (e) {
    logger.error("learning data delete failed", { error: e instanceof Error ? e.message : String(e) });
    return apiError("internal", "تعذّر الحذف الآن. لم يُحذف شيء بالكامل؛ أعد المحاولة.");
  }
}
