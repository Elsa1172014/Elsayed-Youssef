import { authorize } from "@/lib/auth/guard";
import { serverEnv, EnvError } from "@/lib/env";
import { apiError, json, newRequestId, parseBody } from "@/lib/http";
import { checkBudget, rateLimit, recordUsage } from "@/lib/limits";
import { createLogger } from "@/lib/logger";
import { getEmbeddings, getTutorModel } from "@/lib/providers/models";
import { chatSchema } from "@/lib/schemas/tutor";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { runTutorTurn, answerToText } from "@/lib/tutor/engine";
import { appendEvent, applyEvidence, loadHistory, loadTutorContext, sourcesOf } from "@/lib/tutor/persist";
import { createAssessmentPersistence } from "@/lib/tutor/persist-assessment";
import { TurnSink } from "@/lib/tutor/tool-core";

export const maxDuration = 60;

/** Text tutoring turn (also the fallback when voice is unavailable). */
export async function POST(req: Request) {
  const log = createLogger({ route: "tutor.chat", reqId: newRequestId() });
  const a = await authorize(["student", "teacher", "admin"]);
  if (!a.ok) return a.response;
  const body = await parseBody(req, chatSchema);
  if (!body.ok) return body.response;
  const { db, profile } = a.auth;

  let env;
  try {
    env = serverEnv();
  } catch (e) {
    if (e instanceof EnvError) return apiError("not_configured", "الخدمة غير مهيّأة بعد (مفاتيح الخادم ناقصة).");
    throw e;
  }
  const admin = createSupabaseAdmin();

  const rl = await rateLimit(admin, `chat:${profile.id}`, 60, env.RATE_LIMIT_CHAT_PER_MIN);
  if (!rl.ok) return rl.response;
  const perUser = await checkBudget(admin, { userId: profile.id, kind: "tutor_tokens", ceiling: env.BUDGET_TUTOR_TOKENS_PER_USER_DAY });
  if (!perUser.ok) return perUser.response;
  const global = await checkBudget(admin, { userId: null, kind: "tutor_tokens", ceiling: env.BUDGET_GLOBAL_TUTOR_TOKENS_PER_DAY });
  if (!global.ok) return global.response;

  const loaded = await loadTutorContext(db, body.data.sessionId, profile);
  if (!loaded) return apiError("not_found", "الجلسة غير موجودة");
  if (loaded.session.status !== "active") return apiError("conflict", "انتهت هذه الجلسة");
  const ctx = body.data.mode ? { ...loaded.ctx, mode: body.data.mode } : loaded.ctx;

  const retain = profile.allow_transcript_retention;
  const history = await loadHistory(db, ctx.sessionId);
  await appendEvent(db, ctx.sessionId, { type: "user_text", payload: { text: body.data.text } }, retain);

  const sink = new TurnSink();
  try {
    const result = await runTutorTurn({
      model: getTutorModel(),
      env: { ctx, db, embeddings: getEmbeddings(), sink, assessments: createAssessmentPersistence({ db, admin, ctx }) },
      history,
      userText: body.data.text,
      abortSignal: AbortSignal.timeout(50_000),
    });
    await appendEvent(
      db, ctx.sessionId,
      { type: "assistant_text", payload: { text: answerToText(result.answer), answer: result.answer, grounding: result.answer.grounding, mode: ctx.mode }, sources: sourcesOf(result.answer) },
      retain,
    );
    await recordUsage(admin, profile.id, "tutor_tokens", result.totalTokens);
    await recordUsage(admin, profile.id, "embedding_tokens", sink.embeddingTokens);
    if (sink.evidence.length) await applyEvidence(admin, profile.id, ctx.lessonId, sink.evidence);
    log.info("turn complete", { mode: ctx.mode, grounding: result.answer.grounding, tokens: result.totalTokens, retried: result.retried, fellBack: result.fellBack, dropped: result.answer.droppedQuotes });
    return json({ answer: result.answer });
  } catch (e) {
    log.error("turn failed", { error: e instanceof Error ? e.message : String(e) });
    await appendEvent(db, ctx.sessionId, { type: "error", payload: { where: "tutor.chat" } }, true).catch(() => undefined);
    return apiError("upstream_error", "تعذّر الحصول على إجابة الآن. حاول مرة أخرى.");
  }
}
