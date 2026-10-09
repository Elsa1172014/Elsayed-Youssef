import { authorize } from "@/lib/auth/guard";
import { apiError, json, parseBody } from "@/lib/http";
import { rateLimit } from "@/lib/limits";
import { EnvError, serverEnv } from "@/lib/env";
import { confirmPageSchema } from "@/lib/schemas/tutor";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { buildPageContextMessage } from "@/lib/tutor/context-message";
import { appendEvent, loadPageContext, loadTutorContext } from "@/lib/tutor/persist";

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

  let page;
  try {
    page = await loadPageContext(db, loaded.ctx.versionId, pageNumber);
  } catch {
    return apiError("internal", "تعذّر قراءة الصفحة");
  }
  if (!page) return apiError("not_found", "هذه الصفحة غير موجودة في الكتاب");

  const { error: upErr } = await db
    .from("tutoring_sessions")
    .update({ current_page: page.pageNumber, lesson_id: page.lessonId ?? loaded.ctx.lessonId })
    .eq("id", sessionId)
    .eq("student_id", profile.id);
  if (upErr) return apiError("internal", "تعذّر تحديث الجلسة");

  await appendEvent(db, sessionId, { type: "page_confirmed", payload: { pageNumber: page.pageNumber, source, lessonId: page.lessonId } }, true);

  return json({
    confirmed: true,
    context: {
      pageNumber: page.pageNumber,
      printedLabel: page.printedLabel,
      lessonId: page.lessonId,
      lessonTitle: page.lessonTitle,
      bookTitle: page.bookTitle,
      objectives: page.objectives,
    },
    contextMessage: buildPageContextMessage({
      bookTitle: page.bookTitle, lessonTitle: page.lessonTitle, pageNumber: page.pageNumber,
      printedLabel: page.printedLabel, pageText: page.text, objectives: page.objectives,
    }),
  });
}
