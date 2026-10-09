import { authorize } from "@/lib/auth/guard";
import { apiError, json, parseBody } from "@/lib/http";
import { preferencesSchema } from "@/lib/schemas/admin";

/** Per-user privacy preference: whether conversation text is retained (metadata is always kept for analytics). */
export async function PATCH(req: Request) {
  const a = await authorize(["student", "teacher", "admin"]);
  if (!a.ok) return a.response;
  const body = await parseBody(req, preferencesSchema);
  if (!body.ok) return body.response;
  const { error } = await a.auth.db.from("profiles").update({ allow_transcript_retention: body.data.allowTranscriptRetention }).eq("id", a.auth.profile.id);
  if (error) return apiError("internal", "تعذّر حفظ التفضيل");
  return json({ allowTranscriptRetention: body.data.allowTranscriptRetention });
}
