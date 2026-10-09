import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/guard";
import { apiError } from "@/lib/http";
import { rateLimit } from "@/lib/limits";
import { collectStudentData } from "@/lib/privacy/export";
import { uuidSchema } from "@/lib/schemas/admin";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

/** Data export (JSON download). A student exports their own data; an admin may export a student's on request. */
export async function GET(req: Request) {
  const a = await authorize(["student", "teacher", "admin"]);
  if (!a.ok) return a.response;
  const asked = new URL(req.url).searchParams.get("studentId");
  let target = a.auth.profile.id;
  if (asked && asked !== target) {
    if (a.auth.profile.role !== "admin") return apiError("forbidden", "لا يمكنك تصدير بيانات مستخدم آخر");
    const id = uuidSchema.safeParse(asked);
    if (!id.success) return apiError("invalid_input", "معرّف غير صالح");
    target = id.data;
  }
  const admin = createSupabaseAdmin();
  const rl = await rateLimit(admin, `export:${a.auth.profile.id}`, 3600, 3);
  if (!rl.ok) return rl.response;

  const data = await collectStudentData(admin, target);
  await audit(admin, { actorId: a.auth.profile.id, action: "student.export", targetType: "user", targetId: target });
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="my-data-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
