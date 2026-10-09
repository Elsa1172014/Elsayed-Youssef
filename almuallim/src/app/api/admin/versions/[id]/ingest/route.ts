import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/guard";
import { apiError, json, parseBody } from "@/lib/http";
import { ingestSchema, uuidSchema } from "@/lib/schemas/admin";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

/** Admin: queue (or re-queue with force) ingestion for an uploaded version. Idempotent per upload. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await authorize(["admin"]);
  if (!a.ok) return a.response;
  const id = uuidSchema.safeParse((await ctx.params).id);
  if (!id.success) return apiError("invalid_input", "معرّف غير صالح");
  const body = await parseBody(req, ingestSchema);
  if (!body.ok) return body.response;

  const { data: version } = await a.auth.db.from("book_versions").select("id, storage_path, status").eq("id", id.data).single();
  if (!version) return apiError("not_found", "النسخة غير موجودة");

  const admin = createSupabaseAdmin();
  // The PDF must actually be in storage before we queue work for it.
  const slash = version.storage_path.lastIndexOf("/");
  const { data: files, error: listErr } = await admin.storage
    .from("textbooks")
    .list(version.storage_path.slice(0, slash), { search: version.storage_path.slice(slash + 1), limit: 1 });
  if (listErr) return apiError("upstream_error", "تعذّر التحقق من الملف المرفوع");
  if (!files?.some((f) => f.name === version.storage_path.slice(slash + 1))) {
    return apiError("conflict", "لم يتم العثور على ملف PDF المرفوع بعد");
  }

  const { data: job, error } = await admin.rpc("enqueue_ingestion", {
    p_version: id.data,
    p_requested_by: a.auth.profile.id,
    p_force: body.data.force,
  });
  if (error) return apiError("internal", "تعذّر جدولة المعالجة");
  await audit(admin, { actorId: a.auth.profile.id, action: "ingestion.enqueue", targetType: "book_version", targetId: id.data, metadata: { force: body.data.force } });
  return json({ job }, { status: 202 });
}
