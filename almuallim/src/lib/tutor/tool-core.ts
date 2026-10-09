import { z } from "zod";
import type { EmbeddingProvider } from "@/lib/providers/embeddings";
import { assessGrounding, pageLabel, type GroundingLevel, type Passage } from "@/lib/retrieval/grounding";
import { searchTextbook, type RpcClient } from "@/lib/retrieval/search";
import type { Outcome } from "./mastery";
import { levelSchema, skillSchema, type Level, type Skill, type TutorContext } from "./types";

export const searchInput = z.object({ query: z.string().trim().min(2).max(300).describe("Arabic search query describing what to find in the textbook") });
export const pageInput = z.object({ pageNumber: z.number().int().min(1).max(2000) });
export const evidenceInput = z.object({
  skill: skillSchema,
  outcome: z.enum(["correct", "partial", "incorrect"]),
  hintsUsed: z.number().int().min(0).max(3).default(0),
  misconception: z.string().max(300).nullable().default(null),
});
export type EvidenceInput = z.infer<typeof evidenceInput>;

export const rubricItemSchema = z.object({ criterion: z.string().trim().min(2).max(80), maxPoints: z.number().int().min(1).max(5) });
export const proposeQuestionInput = z.object({
  skill: skillSchema,
  level: levelSchema.optional(),
  prompt: z.string().trim().min(5).max(600).describe("The question/exercise to ask the student (Arabic)"),
  rubric: z.array(rubricItemSchema).min(1).max(5).describe("Scoring criteria used later by evaluate_response; NEVER reveal to the student"),
  hints: z.array(z.string().trim().max(200)).max(3).default([]).describe("Graduated hints, level 1 to 3, revealed only on request"),
  sourceChunkIds: z.array(z.string().max(80)).max(3).default([]).describe("chunkIds from search_textbook the question is based on"),
});
export const evaluateResponseInput = z.object({
  itemId: z.string().uuid(),
  studentAnswer: z.string().trim().min(1).max(4000).describe("What the student answered (transcribed if spoken)"),
  points: z.array(z.object({ criterion: z.string().max(80), points: z.number().int().min(0).max(5) })).min(1).max(5),
  feedback: z.string().trim().max(500).describe("The specific feedback you give the student (no numeric grade)"),
  hintsUsed: z.number().int().min(0).max(3).default(0),
  misconception: z.string().trim().max(300).nullable().default(null),
});
export type ProposeQuestionInput = z.infer<typeof proposeQuestionInput>;
export type EvaluateResponseInput = z.infer<typeof evaluateResponseInput>;

export interface RubricItem { criterion: string; maxPoints: number }

/** Storage port for practice/assessment items and AI-estimated scores (implemented per request with RLS + service role). */
export interface AssessmentPersistence {
  createItem(i: { skill: Skill; level: Level; prompt: string; rubric: RubricItem[]; hints: string[]; sourceChunkIds: string[] }): Promise<{ itemId: string; ordinal: number }>;
  getItem(itemId: string): Promise<{ id: string; skill: Skill; rubric: RubricItem[]; sessionId: string | null } | null>;
  saveResponse(r: {
    itemId: string; responseText: string; hintsUsed: number; aiScore: number;
    aiRubric: { criterion: string; points: number; max: number }[]; aiFeedback: string; misconception: string | null;
  }): Promise<{ responseId: string }>;
}

/** Outcome is derived from the rubric score, never taken from the model's say-so. */
export function outcomeFromScore(score: number): Outcome {
  return score >= 85 ? "correct" : score >= 40 ? "partial" : "incorrect";
}

export interface Evidence {
  skill: Skill;
  outcome: Outcome;
  hintsUsed: number;
  misconception: string | null;
}

/** Collects what a turn actually retrieved/recorded so answers can be verified and persisted. */
export class TurnSink {
  passages = new Map<string, Passage>();
  levels: GroundingLevel[] = [];
  evidence: Evidence[] = [];
  embeddingTokens = 0;
  toolCalls: { name: string; ok: boolean }[] = [];

  addPassages(ps: Passage[], level: GroundingLevel) {
    for (const p of ps) if (!this.passages.has(p.chunkId)) this.passages.set(p.chunkId, p);
    this.levels.push(level);
  }
  /** Best retrieval level seen this turn. */
  level(): GroundingLevel {
    return this.levels.includes("strong") ? "strong" : this.levels.includes("weak") ? "weak" : "none";
  }
}

export type TutorDb = RpcClient & { from(table: string): any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ToolEnv {
  ctx: TutorContext;
  db: TutorDb;
  embeddings: EmbeddingProvider;
  sink: TurnSink;
  assessments?: AssessmentPersistence;
}

const NO_BOOK = { error: "no_textbook_selected", message: "لم يُختر كتاب لهذه الجلسة." };

export async function toolSearchTextbook(env: ToolEnv, raw: unknown) {
  const { query } = searchInput.parse(raw);
  const { ctx, sink } = env;
  if (!ctx.versionId) return NO_BOOK;
  // Search the active lesson first; widen to the whole book when that is not clearly sufficient.
  let result = await searchTextbook(env, { query, versionId: ctx.versionId, lessonId: ctx.lessonId, limit: 5 });
  sink.embeddingTokens += result.embeddingTokens;
  let passages = result.passages;
  if (ctx.lessonId && result.grounding.level !== "strong") {
    const wide = await searchTextbook(env, { query, versionId: ctx.versionId, lessonId: null, limit: 5 });
    sink.embeddingTokens += wide.embeddingTokens;
    const merged = new Map(passages.map((p) => [p.chunkId, p]));
    for (const p of wide.passages) if (!merged.has(p.chunkId)) merged.set(p.chunkId, p);
    passages = [...merged.values()].sort((a, b) => b.fusedScore - a.fusedScore).slice(0, 6);
    result = { ...result, passages, grounding: assessGrounding(passages) };
  }
  sink.addPassages(passages, result.grounding.level);
  sink.toolCalls.push({ name: "search_textbook", ok: true });
  return {
    grounding: result.grounding.level,
    note: result.grounding.level === "none" ? "لا توجد نتائج موثوقة في الكتاب لهذا السؤال." : undefined,
    passages: passages.map((p) => ({ chunkId: p.chunkId, lesson: p.lessonTitle, pages: pageLabel(p.pageStart, p.pageEnd), text: p.content })),
  };
}

export async function toolGetPage(env: ToolEnv, raw: unknown) {
  const { pageNumber } = pageInput.parse(raw);
  const { ctx, sink, db } = env;
  if (!ctx.versionId) return NO_BOOK;
  const { data, error } = await db.rpc("get_page_text", { p_book_version_id: ctx.versionId, p_page_number: pageNumber });
  if (error) throw new Error(`get_page_text failed: ${error.message}`);
  const row = (data as { page_number: number; text: string; lesson_title: string | null; lesson_id: string | null }[] | null)?.[0];
  if (!row) return { error: "page_not_found", message: "الصفحة غير متاحة." };
  const id = `page:${row.page_number}`;
  const text = row.text.slice(0, 4000);
  // Reading a page the student confirmed is direct grounding.
  sink.addPassages(
    [{ chunkId: id, lessonId: row.lesson_id, lessonTitle: row.lesson_title, pageStart: row.page_number, pageEnd: row.page_number, content: text, vectorSimilarity: 1, lexicalScore: 1, fusedScore: 1 }],
    "strong",
  );
  sink.toolCalls.push({ name: "get_page", ok: true });
  return { chunkId: id, lesson: row.lesson_title, pages: pageLabel(row.page_number, row.page_number), text };
}

export async function toolLessonOutline(env: ToolEnv) {
  const { ctx, db, sink } = env;
  if (!ctx.versionId) return NO_BOOK;
  const { data, error } = await db.from("lessons").select("title, unit_title, start_page, end_page").eq("book_version_id", ctx.versionId).order("ordinal");
  if (error) throw new Error(`lessons query failed: ${error.message}`);
  sink.toolCalls.push({ name: "get_lesson_outline", ok: true });
  return {
    lessons: (data as { title: string; unit_title: string | null; start_page: number; end_page: number }[]).map((l) => ({
      title: l.title, unit: l.unit_title, pages: pageLabel(l.start_page, l.end_page),
    })),
  };
}

export function toolRecordEvidence(env: ToolEnv, raw: unknown) {
  const e = evidenceInput.parse(raw);
  env.sink.evidence.push({ skill: e.skill, outcome: e.outcome, hintsUsed: e.hintsUsed, misconception: e.misconception });
  env.sink.toolCalls.push({ name: "record_evidence", ok: true });
  return { recorded: true };
}

const NO_STORAGE = { error: "assessment_storage_unavailable", message: "تعذّر حفظ التمرين الآن؛ تابع شفهيًا دون تسجيل." };

export async function toolProposeQuestion(env: ToolEnv, raw: unknown) {
  const i = proposeQuestionInput.parse(raw);
  if (!env.assessments) return NO_STORAGE;
  const known = i.sourceChunkIds.filter((id) => env.sink.passages.has(id)); // only chunks actually retrieved this turn
  const { itemId, ordinal } = await env.assessments.createItem({
    skill: i.skill, level: i.level ?? env.ctx.level, prompt: i.prompt, rubric: i.rubric, hints: i.hints, sourceChunkIds: known,
  });
  env.sink.toolCalls.push({ name: "propose_question", ok: true });
  return { itemId, ordinal, instruction: "اطرح السؤال الآن على الطالب بكلماتك، ثم انتظر إجابته. لا تذكر معايير التقييم ولا الإجابة النموذجية." };
}

export async function toolEvaluateResponse(env: ToolEnv, raw: unknown) {
  const i = evaluateResponseInput.parse(raw);
  if (!env.assessments) return NO_STORAGE;
  const item = await env.assessments.getItem(i.itemId);
  if (!item || (item.sessionId && item.sessionId !== env.ctx.sessionId)) return { error: "item_not_found", message: "السؤال غير موجود في هذه الجلسة." };

  // The scores must follow the rubric that was fixed when the question was asked.
  const byCriterion = new Map(item.rubric.map((r) => [r.criterion, r.maxPoints]));
  const given = new Map<string, number>();
  for (const p of i.points) {
    const max = byCriterion.get(p.criterion);
    if (max === undefined) return { error: "rubric_mismatch", message: "معيار غير موجود في المعايير المحددة.", expectedCriteria: item.rubric };
    if (p.points > max) return { error: "points_exceed_max", message: `الدرجة تتجاوز الحد الأعلى للمعيار «${p.criterion}».`, expectedCriteria: item.rubric };
    given.set(p.criterion, p.points);
  }
  if (given.size !== byCriterion.size) return { error: "rubric_mismatch", message: "يجب تقييم كل المعايير.", expectedCriteria: item.rubric };

  const total = item.rubric.reduce((n, r) => n + r.maxPoints, 0);
  const got = item.rubric.reduce((n, r) => n + (given.get(r.criterion) ?? 0), 0);
  const aiScore = Math.round((got / total) * 1000) / 10;
  const outcome = outcomeFromScore(aiScore);
  await env.assessments.saveResponse({
    itemId: item.id, responseText: i.studentAnswer, hintsUsed: i.hintsUsed, aiScore,
    aiRubric: item.rubric.map((r) => ({ criterion: r.criterion, points: given.get(r.criterion) ?? 0, max: r.maxPoints })),
    aiFeedback: i.feedback, misconception: i.misconception,
  });
  env.sink.evidence.push({ skill: item.skill, outcome, hintsUsed: i.hintsUsed, misconception: i.misconception });
  env.sink.toolCalls.push({ name: "evaluate_response", ok: true });
  // No numeric score is returned: the tutor must not announce grades.
  return { recorded: true, outcome, next: "قدّم للطالب التغذية الراجعة المحددة ثم اقترح الخطوة التالية." };
}

export const TOOL_NAMES = ["search_textbook", "get_page", "get_lesson_outline", "record_evidence", "propose_question", "evaluate_response"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Single dispatch used by BOTH the text tutor (AI SDK tools) and the voice tool endpoint. Validates input. */
export async function executeTool(env: ToolEnv, name: string, input: unknown): Promise<unknown> {
  switch (name) {
    case "search_textbook": return toolSearchTextbook(env, input);
    case "get_page": return toolGetPage(env, input);
    case "get_lesson_outline": return toolLessonOutline(env);
    case "record_evidence": return toolRecordEvidence(env, input);
    case "propose_question": return toolProposeQuestion(env, input);
    case "evaluate_response": return toolEvaluateResponse(env, input);
    default: throw new ToolInputError(`unknown tool: ${name}`);
  }
}

export class ToolInputError extends Error {}
