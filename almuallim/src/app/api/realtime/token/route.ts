import { authorize } from "@/lib/auth/guard";
import { EnvError, serverEnv } from "@/lib/env";
import { apiError, json, newRequestId, parseBody } from "@/lib/http";
import { checkBudget, rateLimit } from "@/lib/limits";
import { createLogger } from "@/lib/logger";
import { realtimeTokenSchema } from "@/lib/schemas/tutor";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { buildPageContextMessage } from "@/lib/tutor/context-message";
import { appendEvent, loadPageContext, loadTutorContext } from "@/lib/tutor/persist";
import { buildSystemPrompt } from "@/lib/tutor/prompt";
import { buildRealtimeSession, mintClientSecret, RealtimeProviderError } from "@/lib/voice/session-config";
import { settleOpenVoice } from "@/lib/voice/usage";

export const maxDuration = 20;
const CALLS_URL = "https://api.openai.com/v1/realtime/calls";

/**
 * Issue a SHORT-LIVED client secret for one realtime voice connection. The permanent OpenAI key never leaves
 * the server. Checks (in order): auth → input → rate limit → budget → session ownership.
 */
export async function POST(req: Request) {
  const log = createLogger({ route: "realtime.token", reqId: newRequestId() });
  const a = await authorize(["student", "teacher", "admin"]);
  if (!a.ok) return a.response;
  const body = await parseBody(req, realtimeTokenSchema);
  if (!body.ok) return body.response;
  const { db, profile } = a.auth;

  let env;
  try {
    env = serverEnv();
  } catch (e) {
    if (e instanceof EnvError) return apiError("not_configured", "الصوت غير مهيّأ بعد (مفاتيح الخادم ناقصة).");
    throw e;
  }
  const admin = createSupabaseAdmin();
  const rl = await rateLimit(admin, `rt:${profile.id}`, 3600, env.RATE_LIMIT_REALTIME_TOKEN_PER_HOUR);
  if (!rl.ok) return rl.response;

  const { sessionId } = body.data;
  // Charge any voice segment that was never closed (e.g. tab killed) before checking today's budget.
  await settleOpenVoice(db, admin, { sessionId, userId: profile.id, now: Date.now(), closing: false });
  const budget = await checkBudget(admin, { userId: profile.id, kind: "realtime_seconds", ceiling: env.BUDGET_REALTIME_SECONDS_PER_USER_DAY });
  if (!budget.ok) return budget.response;

  const loaded = await loadTutorContext(db, sessionId, profile);
  if (!loaded) return apiError("not_found", "الجلسة غير موجودة");
  if (loaded.session.status !== "active") return apiError("conflict", "انتهت هذه الجلسة");

  let instructions = buildSystemPrompt(loaded.ctx, { voice: true });
  if (loaded.ctx.versionId && loaded.ctx.currentPage) {
    const page = await loadPageContext(db, loaded.ctx.versionId, loaded.ctx.currentPage).catch(() => null);
    if (page) {
      instructions += "\n\n" + buildPageContextMessage({ bookTitle: page.bookTitle, lessonTitle: page.lessonTitle, pageNumber: page.pageNumber, printedLabel: page.printedLabel, pageText: page.text, objectives: page.objectives });
    }
  }

  try {
    const secret = await mintClientSecret({
      apiKey: env.OPENAI_API_KEY,
      session: buildRealtimeSession({ model: env.REALTIME_MODEL, voice: env.REALTIME_VOICE, transcribeModel: env.REALTIME_TRANSCRIBE_MODEL, instructions }),
      ttlSeconds: 120,
    });
    // Server-stamped start: the basis for usage accounting (see settleOpenVoice).
    await appendEvent(db, sessionId, { type: "state", payload: { voice: "started" } }, true);
    await db.from("tutoring_sessions").update({ channel: "voice" }).eq("id", sessionId).eq("student_id", profile.id);
    log.info("client secret issued", { model: env.REALTIME_MODEL });
    return json({ clientSecret: secret.value, expiresAt: secret.expiresAt, model: env.REALTIME_MODEL, callsUrl: CALLS_URL });
  } catch (e) {
    const status = e instanceof RealtimeProviderError ? e.status : 0;
    log.error("client secret failed", { status, error: e instanceof Error ? e.message : String(e) });
    return apiError("upstream_error", "تعذّر بدء المحادثة الصوتية الآن. يمكنك المتابعة بالكتابة.");
  }
}
