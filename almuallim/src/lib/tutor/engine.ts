import { generateText, isStepCount, Output, type LanguageModel, type ModelMessage } from "ai";
import { verifyAnswer, tutorAnswerSchema, type TutorAnswer, type VerifiedAnswer } from "./answer";
import { buildSystemPrompt } from "./prompt";
import type { ToolEnv } from "./tool-core";
import { buildTutorTools } from "./tools";
import { NO_STORE } from "@/lib/providers/privacy";
import type { Mode } from "./types";

const GUARDED_MODES: Mode[] = ["practice", "assessment", "socratic"];

const CORRECTION = [
  "تنبيه من النظام: ردّك السابق خالف القواعد (حلّ التمرين للطالب أو لم يطرح سؤالًا موجِّهًا).",
  "أعد الصياغة: لا تكشف الإجابة النهائية، واسأل الطالب عن محاولته أو قدّم تلميحًا من المستوى الأول فقط، واجعل completesExerciseForStudent=false.",
].join(" ");

export const SAFE_FALLBACK: VerifiedAnswer = {
  segments: [
    { kind: "explanation", text: "دعنا نفكّر معًا أولًا." },
    { kind: "question", text: "ما محاولتك الأولى؟ اكتبها أو قلها بصوتك، وسأساعدك خطوة بخطوة." },
  ],
  grounding: "ungrounded",
  sources: [],
  droppedQuotes: 0,
  detectedMisconception: null,
  suggestedNextStep: null,
};

export interface TurnResult {
  answer: VerifiedAnswer;
  totalTokens: number;
  retried: boolean;
  fellBack: boolean;
}

function violatesPedagogy(mode: Mode, raw: TutorAnswer): boolean {
  if (!GUARDED_MODES.includes(mode)) return false;
  if (raw.completesExerciseForStudent) return true;
  if (mode === "socratic" && !raw.segments.some((s) => s.kind === "question" || s.kind === "hint")) return true;
  return false;
}

/**
 * One tutoring turn: tool-assisted generation → code-side verification of quotes/grounding →
 * pedagogy guard (one corrective retry, then a safe fallback). Throws on provider failure so the
 * caller can report a retryable upstream error.
 */
export async function runTutorTurn(p: {
  model: LanguageModel;
  env: ToolEnv;
  history: ModelMessage[];
  userText: string;
  /** Extra system text for this turn only (e.g. safeguarding note). */
  extraSystem?: string;
  abortSignal?: AbortSignal;
}): Promise<TurnResult> {
  const { env } = p;
  const system = buildSystemPrompt(env.ctx) + (p.extraSystem ? `\n\n${p.extraSystem}` : "");
  const messages: ModelMessage[] = [...p.history, { role: "user", content: p.userText }];
  const tools = buildTutorTools(env);
  let tokens = 0;

  const generate = async (extraSystem?: string): Promise<TutorAnswer> => {
    const r = await generateText({
      model: p.model,
      system: extraSystem ? `${system}\n\n${extraSystem}` : system,
      messages,
      tools,
      output: Output.object({ schema: tutorAnswerSchema }),
      stopWhen: isStepCount(6), // tool call(s) + final structured-output step
      abortSignal: p.abortSignal,
      maxRetries: 2,
      providerOptions: NO_STORE,
    });
    tokens += r.totalUsage?.totalTokens ?? 0;
    return r.output;
  };

  let raw = await generate();
  let retried = false;
  if (violatesPedagogy(env.ctx.mode, raw)) {
    retried = true;
    raw = await generate(CORRECTION);
    if (violatesPedagogy(env.ctx.mode, raw)) {
      return { answer: SAFE_FALLBACK, totalTokens: tokens, retried, fellBack: true };
    }
  }
  const answer = verifyAnswer(raw, [...env.sink.passages.values()], env.sink.level());
  return { answer, totalTokens: tokens, retried, fellBack: false };
}

/** Plain-text rendering of a verified answer for history replay and the transcript. */
export function answerToText(a: VerifiedAnswer): string {
  return a.segments
    .map((s) => (s.kind === "quote" ? `«${s.text}» (${s.source.label})` : s.kind === "hint" ? `تلميح ${s.level}: ${s.text}` : s.text))
    .join("\n");
}
