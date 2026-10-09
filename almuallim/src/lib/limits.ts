import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextResponse } from "next/server";
import { apiError } from "@/lib/http";

/** Fixed-window rate limit backed by PostgreSQL (works across serverless instances). */
export async function rateLimit(
  admin: SupabaseClient,
  key: string,
  windowSeconds: number,
  max: number,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const { data, error } = await admin.rpc("rate_limit_hit", { p_key: key, p_window_seconds: windowSeconds, p_max: max });
  if (error) {
    // Fail CLOSED: a broken limiter must not turn into unlimited spend.
    return { ok: false, response: apiError("internal", "تعذّر التحقق من حدود الاستخدام") };
  }
  if (data === false) return { ok: false, response: apiError("rate_limited", "طلبات كثيرة، حاول بعد قليل", { retryAfterSec: windowSeconds }) };
  return { ok: true };
}

export type UsageKind = "tutor_tokens" | "embedding_tokens" | "vision_calls" | "realtime_seconds";

const startOfUtcDay = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
};

/** Daily budget ceilings, checked BEFORE calling a paid provider. Pass userId=null for a global ceiling. */
export async function checkBudget(
  admin: SupabaseClient,
  opts: { userId: string | null; kind: UsageKind; ceiling: number },
): Promise<{ ok: true; used: number } | { ok: false; response: NextResponse }> {
  const { data, error } = await admin.rpc("usage_sum", { p_user: opts.userId, p_kind: opts.kind, p_since: startOfUtcDay() });
  if (error) return { ok: false, response: apiError("internal", "تعذّر التحقق من الميزانية") };
  const used = Number(data ?? 0);
  if (used >= opts.ceiling) return { ok: false, response: apiError("budget_exceeded", "تم بلوغ الحد اليومي للاستخدام") };
  return { ok: true, used };
}

export async function recordUsage(admin: SupabaseClient, userId: string, kind: UsageKind, amount: number): Promise<void> {
  if (amount <= 0) return;
  await admin.from("usage_ledger").insert({ user_id: userId, kind, amount });
}
