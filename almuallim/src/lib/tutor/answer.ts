import { z } from "zod";
import { normalizeArabic } from "@/lib/arabic/normalize";
import { pageLabel, type GroundingLevel, type Passage } from "@/lib/retrieval/grounding";

/** What the model must return. Every field is required (strict structured-output friendly). */
export const tutorAnswerSchema = z.object({
  segments: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("quote"), chunkId: z.string().describe("chunkId of a passage returned by search_textbook"), text: z.string().describe("VERBATIM excerpt copied from that passage") }),
        z.object({ kind: z.literal("explanation"), text: z.string() }),
        z.object({ kind: z.literal("question"), text: z.string() }),
        z.object({ kind: z.literal("hint"), level: z.number().int().min(1).max(3), text: z.string() }),
      ]),
    )
    .min(1)
    .max(12),
  grounding: z.enum(["grounded", "partial", "ungrounded"]).describe("grounded = every curriculum claim comes from retrieved passages"),
  completesExerciseForStudent: z.boolean().describe("true if this reply gives the final answer to an exercise the student has not attempted"),
  detectedMisconception: z.string().nullable(),
  suggestedNextStep: z.string().nullable(),
});
export type TutorAnswer = z.infer<typeof tutorAnswerSchema>;

export interface SourceRef {
  chunkId: string;
  lessonTitle: string | null;
  pageStart: number;
  pageEnd: number;
  label: string; // e.g. "ص ٢–٣"
}

export type VerifiedSegment =
  | { kind: "quote"; text: string; source: SourceRef }
  | { kind: "explanation" | "question" | "notice"; text: string }
  | { kind: "hint"; level: number; text: string };

export interface VerifiedAnswer {
  segments: VerifiedSegment[];
  grounding: "grounded" | "partial" | "ungrounded";
  sources: SourceRef[];
  droppedQuotes: number;
  detectedMisconception: string | null;
  suggestedNextStep: string | null;
}

export const MAX_QUOTE_CHARS = 600;
export const MIN_QUOTE_CHARS = 6;

/** A quote is valid only if it appears verbatim (after Arabic normalisation) in the chunk it cites. "…" splits fragments. */
export function quoteIsFromChunk(quote: string, chunkContent: string): boolean {
  if (quote.length > MAX_QUOTE_CHARS) return false;
  const hay = normalizeArabic(chunkContent);
  const parts = quote.split(/\s*(?:…|\.{3})\s*/).map(normalizeArabic).filter(Boolean);
  if (!parts.length) return false;
  if (parts.reduce((n, p) => n + p.length, 0) < MIN_QUOTE_CHARS) return false;
  return parts.every((p) => hay.includes(p));
}

const NOTICE_UNGROUNDED = "ملاحظة: لم أجد هذه المعلومة في الكتاب المدرسي، فالإجابة التالية من معرفتي العامة وقد لا تطابق منهجك. راجع معلّمك للتأكد.";
const NOTICE_PARTIAL = "ملاحظة: وجدتُ في الكتاب ما يتصل بسؤالك جزئيًا فقط؛ فصلتُ بين ما ورد في الكتاب وبين شرحي.";

/**
 * Turn the model's answer into what the student sees, enforcing in CODE (not just in the prompt):
 *  - quotes must come from passages actually retrieved this turn and be verbatim;
 *  - the reported grounding can never be stronger than what retrieval supports;
 *  - ungrounded/partial answers always carry a visible notice.
 */
export function verifyAnswer(raw: TutorAnswer, retrieved: Passage[], retrievalLevel: GroundingLevel): VerifiedAnswer {
  const byId = new Map(retrieved.map((p) => [p.chunkId, p]));
  const segments: VerifiedSegment[] = [];
  const used = new Map<string, SourceRef>();
  let dropped = 0;
  for (const s of raw.segments) {
    if (s.kind === "quote") {
      const p = byId.get(s.chunkId);
      if (!p || !quoteIsFromChunk(s.text, p.content)) {
        dropped++;
        continue;
      }
      const ref: SourceRef = { chunkId: p.chunkId, lessonTitle: p.lessonTitle, pageStart: p.pageStart, pageEnd: p.pageEnd, label: pageLabel(p.pageStart, p.pageEnd) };
      used.set(p.chunkId, ref);
      segments.push({ kind: "quote", text: s.text.trim(), source: ref });
    } else if (s.kind === "hint") segments.push({ kind: "hint", level: s.level, text: s.text });
    else segments.push({ kind: s.kind, text: s.text });
  }

  let grounding: VerifiedAnswer["grounding"] = raw.grounding;
  if (retrieved.length === 0 || retrievalLevel === "none") grounding = "ungrounded";
  else if (retrievalLevel === "weak" && grounding === "grounded") grounding = "partial";
  if (grounding === "grounded" && used.size === 0) grounding = "partial"; // claims grounding but cites nothing verifiable

  if (grounding === "ungrounded") segments.unshift({ kind: "notice", text: NOTICE_UNGROUNDED });
  else if (grounding === "partial") segments.unshift({ kind: "notice", text: NOTICE_PARTIAL });

  return {
    segments,
    grounding,
    sources: [...used.values()],
    droppedQuotes: dropped,
    detectedMisconception: raw.detectedMisconception,
    suggestedNextStep: raw.suggestedNextStep,
  };
}
