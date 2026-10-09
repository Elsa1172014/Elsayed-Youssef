import { authorize } from "@/lib/auth/guard";
import { EnvError, serverEnv } from "@/lib/env";
import { apiError, json, newRequestId } from "@/lib/http";
import { checkBudget, rateLimit, recordUsage } from "@/lib/limits";
import { createLogger } from "@/lib/logger";
import { getEmbeddings, getRecognizer } from "@/lib/providers/models";
import { uuidSchema } from "@/lib/schemas/admin";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { loadTutorContext, appendEvent } from "@/lib/tutor/persist";
import { sniffImageType } from "@/lib/vision/camera";
import { recognizePage } from "@/lib/vision/recognize";

export const maxDuration = 45;
const MAX_IMAGE_BYTES = 2_500_000;

/**
 * Camera capture → candidate pages with confidence. The image is processed in memory and is NEVER stored;
 * only the decision and candidate page numbers are logged to the session. Selection still requires confirmation.
 */
export async function POST(req: Request) {
  const log = createLogger({ route: "vision.recognize", reqId: newRequestId() });
  const a = await authorize(["student", "teacher", "admin"]);
  if (!a.ok) return a.response;
  const { db, profile } = a.auth;

  if (Number(req.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES + 10_000) return apiError("invalid_input", "الصورة كبيرة جدًا");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError("invalid_input", "طلب غير صالح");
  }
  const sessionId = uuidSchema.safeParse(form.get("sessionId"));
  const file = form.get("image");
  if (!sessionId.success || !(file instanceof Blob)) return apiError("invalid_input", "مدخلات غير صالحة");
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) return apiError("invalid_input", "حجم الصورة غير مقبول");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mediaType = sniffImageType(bytes);
  if (!mediaType) return apiError("invalid_input", "نوع الصورة غير مدعوم");

  let env;
  try {
    env = serverEnv();
  } catch (e) {
    if (e instanceof EnvError) return apiError("not_configured", "الخدمة غير مهيّأة بعد (مفاتيح الخادم ناقصة).");
    throw e;
  }
  const admin = createSupabaseAdmin();
  const rl = await rateLimit(admin, `vision:${profile.id}`, 60, env.RATE_LIMIT_VISION_PER_MIN);
  if (!rl.ok) return rl.response;
  const budget = await checkBudget(admin, { userId: profile.id, kind: "vision_calls", ceiling: env.BUDGET_VISION_CALLS_PER_USER_DAY });
  if (!budget.ok) return budget.response;

  const loaded = await loadTutorContext(db, sessionId.data, profile);
  if (!loaded) return apiError("not_found", "الجلسة غير موجودة");
  if (!loaded.ctx.versionId) return apiError("conflict", "اختر الكتاب أولًا");
  if (loaded.session.status !== "active") return apiError("conflict", "انتهت هذه الجلسة");

  try {
    const out = await recognizePage(
      { db, embeddings: getEmbeddings(), recognizer: getRecognizer() },
      { versionId: loaded.ctx.versionId, image: bytes, mediaType, signal: AbortSignal.timeout(40_000) },
    );
    await recordUsage(admin, profile.id, "vision_calls", 1);
    await recordUsage(admin, profile.id, "embedding_tokens", out.embeddingTokens);
    const summary =
      out.status === "no_page"
        ? { status: "no_page" as const }
        : {
            status: "matched" as const,
            decision: out.match.decision,
            confidence: Math.round(out.match.confidence * 100) / 100,
            reason: out.match.reason,
            candidates: out.match.candidates.map((c) => ({
              pageNumber: c.pageNumber, printedLabel: c.printedLabel, lessonTitle: c.lessonTitle, score: Math.round(c.score * 100) / 100,
              printedNumberMatch: c.printedNumberMatch,
            })),
          };
    await appendEvent(
      db, sessionId.data,
      { type: "vision_recognition", payload: { ...summary, observation: { printedPageNumber: out.observation.printedPageNumber, legibility: out.observation.legibility, textChars: out.observation.textChars } } },
      true, // contains no free text: only page numbers/scores
    );
    log.info("recognition", { status: summary.status, decision: "decision" in summary ? summary.decision : undefined, tokens: out.tokens });
    return json({ ...summary, observation: out.observation });
  } catch (e) {
    log.error("recognition failed", { error: e instanceof Error ? e.message : String(e) });
    return apiError("upstream_error", "تعذّر تحليل الصورة الآن. حاول مرة أخرى أو اكتب رقم الصفحة.");
  }
}
