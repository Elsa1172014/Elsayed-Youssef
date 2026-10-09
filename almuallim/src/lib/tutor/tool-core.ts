import { z } from "zod";
import type { EmbeddingProvider } from "@/lib/providers/embeddings";
import { assessGrounding, pageLabel, type GroundingLevel, type Passage } from "@/lib/retrieval/grounding";
import { searchTextbook, type RpcClient } from "@/lib/retrieval/search";
import type { Outcome } from "./mastery";
import { skillSchema, type Skill, type TutorContext } from "./types";

export const searchInput = z.object({ query: z.string().trim().min(2).max(300).describe("Arabic search query describing what to find in the textbook") });
export const pageInput = z.object({ pageNumber: z.number().int().min(1).max(2000) });
export const evidenceInput = z.object({
  skill: skillSchema,
  outcome: z.enum(["correct", "partial", "incorrect"]),
  hintsUsed: z.number().int().min(0).max(3).default(0),
  misconception: z.string().max(300).nullable().default(null),
});
export type EvidenceInput = z.infer<typeof evidenceInput>;

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

export const TOOL_NAMES = ["search_textbook", "get_page", "get_lesson_outline", "record_evidence"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Single dispatch used by BOTH the text tutor (AI SDK tools) and the voice tool endpoint. Validates input. */
export async function executeTool(env: ToolEnv, name: string, input: unknown): Promise<unknown> {
  switch (name) {
    case "search_textbook": return toolSearchTextbook(env, input);
    case "get_page": return toolGetPage(env, input);
    case "get_lesson_outline": return toolLessonOutline(env);
    case "record_evidence": return toolRecordEvidence(env, input);
    default: throw new ToolInputError(`unknown tool: ${name}`);
  }
}

export class ToolInputError extends Error {}
