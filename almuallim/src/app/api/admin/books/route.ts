import { randomUUID } from "node:crypto";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/guard";
import { apiError, json, parseBody } from "@/lib/http";
import { logger } from "@/lib/logger";
import { createBookSchema } from "@/lib/schemas/admin";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

/** Admin: register a book + version and receive a signed upload URL for the PDF (private bucket). */
export async function POST(req: Request) {
  const a = await authorize(["admin"]);
  if (!a.ok) return a.response;
  const body = await parseBody(req, createBookSchema);
  if (!body.ok) return body.response;
  const input = body.data;
  const { db, profile } = a.auth;

  // Writes go through the admin's own session: RLS (books_write / book_versions_write) is the second gate.
  const { data: book, error: bookErr } = await db
    .from("books")
    .insert({
      title: input.title,
      year_min: input.yearMin,
      year_max: input.yearMax,
      publisher: input.publisher ?? null,
      license_attestation: input.licenseAttestation,
      license_attested_by: profile.id,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (bookErr || !book) {
    logger.error("book insert failed", { error: bookErr?.message });
    return apiError("internal", "تعذّر إنشاء الكتاب");
  }

  const versionId = randomUUID();
  const storagePath = `books/${book.id}/${versionId}.pdf`;
  const { error: verErr } = await db.from("book_versions").insert({
    id: versionId,
    book_id: book.id,
    version_label: input.versionLabel,
    status: "uploaded",
    storage_path: storagePath,
    file_sha256: input.fileSha256,
    uploaded_by: profile.id,
  });
  if (verErr) {
    await db.from("books").delete().eq("id", book.id);
    return apiError(verErr.code === "23505" ? "conflict" : "internal", "تعذّر إنشاء نسخة الكتاب");
  }

  const admin = createSupabaseAdmin();
  const { data: signed, error: signErr } = await admin.storage.from("textbooks").createSignedUploadUrl(storagePath);
  if (signErr || !signed) {
    logger.error("signed upload url failed", { error: signErr?.message });
    return apiError("upstream_error", "تعذّر تجهيز رابط الرفع");
  }
  await audit(admin, {
    actorId: profile.id,
    action: "book.create",
    targetType: "book_version",
    targetId: versionId,
    metadata: { bookId: book.id, sha256: input.fileSha256, size: input.fileSize, attestation: input.licenseAttestation },
  });
  return json({ bookId: book.id, versionId, storagePath, upload: { path: signed.path, token: signed.token } }, { status: 201 });
}
