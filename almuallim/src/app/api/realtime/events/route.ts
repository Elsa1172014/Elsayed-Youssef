import { authorize } from "@/lib/auth/guard";
import { apiError, json, parseBody } from "@/lib/http";
import { realtimeEventsSchema } from "@/lib/schemas/tutor";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { appendEvent, loadTutorContext } from "@/lib/tutor/persist";
import { settleOpenVoice } from "@/lib/voice/usage";

/** Persist voice transcripts and connection-state events reported by the client (RLS + retention preference apply). */
export async function POST(req: Request) {
  const a = await authorize(["student", "teacher", "admin"]);
  if (!a.ok) return a.response;
  const body = await parseBody(req, realtimeEventsSchema, 64 * 1024);
  if (!body.ok) return body.response;
  const { db, profile } = a.auth;
  const { sessionId, events } = body.data;

  const loaded = await loadTutorContext(db, sessionId, profile);
  if (!loaded) return apiError("not_found", "الجلسة غير موجودة");

  for (const e of events) {
    if (e.type === "user_speech") await appendEvent(db, sessionId, { type: "user_speech", payload: { text: e.text } }, profile.allow_transcript_retention);
    else if (e.type === "assistant_speech") await appendEvent(db, sessionId, { type: "assistant_speech", payload: { text: e.text, interrupted: e.interrupted } }, profile.allow_transcript_retention);
    else if (e.type === "error") await appendEvent(db, sessionId, { type: "error", payload: { where: "voice", code: e.code } }, true);
    else {
      if (e.voice === "ended") await settleOpenVoice(db, createSupabaseAdmin(), { sessionId, userId: profile.id, now: Date.now(), closing: true });
      // "started" is stamped by the token route, never by the client.
      if (e.voice !== "started") await appendEvent(db, sessionId, { type: "state", payload: { voice: e.voice } }, true);
    }
  }
  return json({ ok: true, stored: events.length });
}
