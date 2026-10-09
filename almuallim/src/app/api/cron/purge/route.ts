import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { cronEnv, EnvError } from "@/lib/env";
import { apiError, json } from "@/lib/http";
import { logger } from "@/lib/logger";

/**
 * Daily retention job (Vercel Cron). Strips free text from old conversation events. Protected by CRON_SECRET:
 * Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when the variable is set. Without it the
 * endpoint refuses to run, so it can never be triggered anonymously.
 */
export async function GET(req: Request) {
  let env;
  try {
    env = cronEnv();
  } catch (e) {
    if (e instanceof EnvError) return apiError("not_configured", "الوظيفة غير مهيّأة (CRON_SECRET ناقص).");
    throw e;
  }
  const given = Buffer.from((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(env.CRON_SECRET);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return apiError("unauthenticated", "غير مصرّح");

  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc("purge_old_transcripts", { p_days: env.TRANSCRIPT_RETENTION_DAYS });
  if (error) {
    logger.error("purge failed", { error: error.message });
    return apiError("internal", "فشل التنظيف");
  }
  await admin.from("audit_logs").insert({ actor_id: null, action: "retention.purge", target_type: "session_events", metadata: { days: env.TRANSCRIPT_RETENTION_DAYS, rows: data } });
  logger.info("retention purge", { rows: data, days: env.TRANSCRIPT_RETENTION_DAYS });
  return json({ purged: data });
}
