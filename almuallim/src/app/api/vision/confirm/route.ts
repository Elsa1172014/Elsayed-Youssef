import { authorize } from "@/lib/auth/guard";
import { apiError, json, parseBody } from "@/lib/http";
import { rateLimit } from "@/lib/limits";
import { EnvError, serverEnv } from "@/lib/env";
import { confirmPageSchema } from "@/lib/schemas/tutor";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { buildPageContextMessage } from "@/lib/tutor/context-message";
import { appendEvent, loadTutorContext } from "@/lib/tutor/persist";

/**
 * The student's explicit confirmation of a page (from camera candidates or typed manually).
 * Only a confirmed page changes the session context; the validated context is returned so a live voice
 * session can be updated without reconnecting.
 */
export async function POST(req: Request) {
  const a = await authorize(["student", "teacher", "admin"]);
  if (!a.ok) return a.response;
  const body = await parseBody(req, confirmPageSchema);
  if (!body.ok) return body.response;
  const { db, profile } = a.auth;
  const { sessionId, pageNumber, source, accepted } = body.data;

  try {
    const env = serverEnv();
    const rl = await rateLimit(createSupabaseAdmin(), `confirm:${profile.id}`, 60, env.RATE_LIMIT_CHAT_PER_MIN * 2);
    if (!rl.ok) return rl.response;
  } catch (e) {
    if (e instanceof EnvError) return apiError("not_configured", "الخدمة غير مهيّأة بعد.");
    throw e;
  }

  const loaded = await loadTutorContext(db, sessionId, profile);
  if (!loaded) return apiError("not_found", "الجلسة غير موجودة");
  if (!loaded.ctx.versionId) return apiError("conflict", "اختر الكتاب أولًا");

  if (!accepted) {
    await appendEvent(db, sessionId, { type: "page_rejected", payload: { pageNumber, source } }, true);
    return json({ confirmed: false });
  }

  const { data: rows, error } = await db.rpc("get_page_text", { p_book_version_id: loaded.ctx.versionId, p_page_number: pageNumber });
  if (error) return apiError("internal", "تعذّر قراءة الصفحة");
  const page = (rows as { page_number: number; printed_label: string | null; text: string; lesson_id: string | null; lesson_title: string | null }[] | null)?.[0];
  if (!page) return apiError("not_found", "هذه الصفحة غير موجودة في الكتاب");

  const { error: upErr } = await db
    .from("tutoring_sessions")
    .update({ current_page: page.page_number, lesson_id: page.lesson_id ?? loaded.ctx.lessonId })
    .eq("id", sessionId)
    .eq("student_id", profile.id);
  if (upErr) return apiError("internal", "تعذّر تحديث الجلسة");

  const [{ data: bv }, { data: lesson }] = await Promise.all([
    db.from("book_versions").select("books(title)").eq("id", loaded.ctx.versionId).single(),
    page.lesson_id ? db.from("lessons").select("learning_objectives, verified_at").eq("id", page.lesson_id).single() : Promise.resolve({ data: null }),
  ]);
  const books = (bv as { books: { title: string } | { title: string }[] | null } | null)?.books;
  const bookTitle = (Array.isArray(books) ? books[0]?.title : books?.title) ?? "الكتاب";
  const l = lesson as { learning_objectives: string[]; verified_at: string | null } | null;
  const objectives = l?.verified_at ? (l.learning_objectives ?? []) : []; // only teacher-verified objectives are surfaced

  await appendEvent(db, sessionId, { type: "page_confirmed", payload: { pageNumber: page.page_number, source, lessonId: page.lesson_id } }, true);

  return json({
    confirmed: true,
    context: {
      pageNumber: page.page_number,
      printedLabel: page.printed_label,
      lessonId: page.lesson_id,
      lessonTitle: page.lesson_title,
      bookTitle,
      objectives,
    },
    contextMessage: buildPageContextMessage({ bookTitle, lessonTitle: page.lesson_title, pageNumber: page.page_number, printedLabel: page.printed_label, pageText: page.text, objectives }),
  });
}
