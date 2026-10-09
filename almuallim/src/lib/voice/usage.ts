import type { SupabaseClient } from "@supabase/supabase-js";
import { recordUsage } from "@/lib/limits";

export const MAX_VOICE_SEGMENT_SECONDS = 3600;
/** If a voice segment was never closed (tab killed), charge at most this much when we discover it. */
export const ABANDONED_VOICE_CHARGE_SECONDS = 600;

interface StateRow { payload: { voice?: string } | null; created_at: string; seq: number }

/**
 * Server-side voice time accounting that cannot be inflated or skipped by the client: durations are measured
 * between server-stamped `state` events. An unfinished segment is charged (capped) the next time we notice it.
 */
export async function settleOpenVoice(
  db: SupabaseClient,
  admin: SupabaseClient,
  p: { sessionId: string; userId: string; now: number; closing: boolean },
): Promise<number> {
  const { data } = await db
    .from("session_events")
    .select("payload, created_at, seq")
    .eq("session_id", p.sessionId)
    .eq("type", "state")
    .order("seq", { ascending: false })
    .limit(10);
  const rows = (data ?? []) as StateRow[];
  const lastStarted = rows.find((r) => r.payload?.voice === "started");
  if (!lastStarted) return 0;
  const closedAfter = rows.some((r) => r.payload?.voice === "ended" && r.seq > lastStarted.seq);
  if (closedAfter) return 0;
  const elapsed = Math.max(0, Math.round((p.now - new Date(lastStarted.created_at).getTime()) / 1000));
  const charge = p.closing ? Math.min(elapsed, MAX_VOICE_SEGMENT_SECONDS) : Math.min(elapsed, ABANDONED_VOICE_CHARGE_SECONDS);
  await recordUsage(admin, p.userId, "realtime_seconds", charge);
  return charge;
}
