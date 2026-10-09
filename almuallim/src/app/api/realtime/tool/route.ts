import { authorize } from "@/lib/auth/guard";
import { EnvError, serverEnv } from "@/lib/env";
import { apiError, json, newRequestId, parseBody } from "@/lib/http";
import { rateLimit, recordUsage } from "@/lib/limits";
import { createLogger } from "@/lib/logger";
import { getEmbeddings } from "@/lib/providers/models";
import { realtimeToolSchema } from "@/lib/schemas/tutor";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { applyEvidence, loadTutorContext } from "@/lib/tutor/persist";
import { executeTool, TurnSink } from "@/lib/tutor/tool-core";

export const maxDuration = 30;
const MAX_OUTPUT_CHARS = 12_000;

/**
 * Executes a tool call requested by the realtime model, under the CALLER's identity (RLS applies) and with the
 * session context rebuilt server-side — the browser only relays name + arguments.
 * Tool-level failures return 200 with an error payload so the spoken conversation can recover gracefully.
 */
export async function POST(req: Request) {
  const log = createLogger({ route: "realtime.tool", reqId: newRequestId() });
  const a = await authorize(["student", "teacher", "admin"]);
  if (!a.ok) return a.response;
  const body = await parseBody(req, realtimeToolSchema, 8 * 1024);
  if (!body.ok) return body.response;
  const { db, profile } = a.auth;

  let env;
  try {
    env = serverEnv();
  } catch (e) {
    if (e instanceof EnvError) return apiError("not_configured", "الخدمة غير مهيّأة بعد.");
    throw e;
  }
  const admin = createSupabaseAdmin();
  const rl = await rateLimit(admin, `rtool:${profile.id}`, 60, env.RATE_LIMIT_CHAT_PER_MIN * 3);
  if (!rl.ok) return rl.response;

  const loaded = await loadTutorContext(db, body.data.sessionId, profile);
  if (!loaded) return apiError("not_found", "الجلسة غير موجودة");

  let args: unknown = body.data.arguments;
  if (typeof args === "string") {
    try {
      args = args.trim() ? JSON.parse(args) : {};
    } catch {
      return json({ ok: false, output: JSON.stringify({ error: "invalid_arguments", message: "الوسائط ليست JSON صالحًا" }) });
    }
  }

  const sink = new TurnSink();
  try {
    const result = await executeTool({ ctx: loaded.ctx, db, embeddings: getEmbeddings(), sink }, body.data.name, args);
    if (sink.embeddingTokens) await recordUsage(admin, profile.id, "embedding_tokens", sink.embeddingTokens);
    if (sink.evidence.length) await applyEvidence(admin, profile.id, loaded.ctx.lessonId, sink.evidence);
    const output = JSON.stringify(result).slice(0, MAX_OUTPUT_CHARS);
    return json({ ok: true, output, grounding: sink.level() });
  } catch (e) {
    log.warn("tool failed", { tool: body.data.name, error: e instanceof Error ? e.message : String(e) });
    return json({ ok: false, output: JSON.stringify({ error: "tool_failed", message: "تعذّر تنفيذ الأداة؛ أخبر الطالب أنك لم تتمكن من البحث الآن." }) });
  }
}
