import { describe, expect, it } from "vitest";
import { runTutorTurn, SAFE_FALLBACK, answerToText } from "@/lib/tutor/engine";
import { TurnSink, type ToolEnv } from "@/lib/tutor/tool-core";
import type { TutorContext } from "@/lib/tutor/types";
import { FakeEmbeddings } from "../helpers/fakes";
import { scriptedModel, textTurn, toolTurn } from "../helpers/mock-model";

const CHUNK = "الفاعل اسم مرفوع يدل على من قام بالفعل أو اتصف به، ويأتي بعد الفعل مباشرة.";
const row = (sim: number, lex = 0.2) => ({ chunk_id: "chunk-1", lesson_id: "l1", lesson_title: "الدرس الأول: الفاعل", page_start: 2, page_end: 3, content: CHUNK, vector_similarity: sim, lexical_score: lex, fused_score: 0.03 });

function setup(over: Partial<TutorContext> = {}, rows: ReturnType<typeof row>[] = [row(0.6)]) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const ctx: TutorContext = {
    sessionId: "s1", studentId: "u1", yearGroup: 9, mode: "explain", level: "core", versionId: "v1", lessonId: "l1",
    lessonTitle: "الدرس الأول: الفاعل", currentPage: 2, objective: null, mastery: {}, ...over,
  };
  const env: ToolEnv = {
    ctx, embeddings: new FakeEmbeddings(), sink: new TurnSink(),
    db: { rpc: async (name, args) => (rpcCalls.push({ name, args }), { data: name === "search_content" ? rows : [], error: null }), from: () => ({}) },
  };
  return { env, rpcCalls };
}
const base = { completesExerciseForStudent: false, detectedMisconception: null, suggestedNextStep: null };

describe("runTutorTurn", () => {
  it("searches the book via a tool call, then returns a verified, cited answer", async () => {
    const { env, rpcCalls } = setup();
    const model = scriptedModel([
      toolTurn("search_textbook", { query: "ما هو الفاعل" }),
      textTurn({ ...base, grounding: "grounded", segments: [
        { kind: "quote", chunkId: "chunk-1", text: "الفاعل اسم مرفوع يدل على من قام بالفعل" },
        { kind: "explanation", text: "أي أن الفاعل هو من فعل الفعل." },
        { kind: "question", text: "من فاعل الفعل في: كتب الطالب؟" },
      ] }),
    ]);
    const r = await runTutorTurn({ model, env, history: [], userText: "ما هو الفاعل؟" });
    expect(rpcCalls.some((c) => c.name === "search_content")).toBe(true);
    expect(r.answer.grounding).toBe("grounded");
    expect(r.answer.segments[0]).toMatchObject({ kind: "quote", source: { label: "ص ٢–٣" } });
    expect(r.answer.sources[0]!.lessonTitle).toContain("الفاعل");
    expect(r.totalTokens).toBeGreaterThan(0);
    expect(answerToText(r.answer)).toContain("(ص ٢–٣)");
  });

  it("drops a fabricated quote and says so (partial notice) instead of showing it", async () => {
    const { env } = setup();
    const model = scriptedModel([
      toolTurn("search_textbook", { query: "الفاعل" }),
      textTurn({ ...base, grounding: "grounded", segments: [{ kind: "quote", chunkId: "chunk-1", text: "الفاعل اسم منصوب دائمًا وهو أهم أبواب النحو" }, { kind: "explanation", text: "شرح" }] }),
    ]);
    const r = await runTutorTurn({ model, env, history: [], userText: "ما الفاعل؟" });
    expect(r.answer.droppedQuotes).toBe(1);
    expect(r.answer.grounding).toBe("partial");
    expect(r.answer.segments.some((s) => s.kind === "quote")).toBe(false);
    expect(r.answer.segments[0]!.kind).toBe("notice");
  });

  it("answers ungrounded with an explicit notice when retrieval finds nothing", async () => {
    const { env } = setup({}, []);
    const model = scriptedModel([
      toolTurn("search_textbook", { query: "موضوع غير موجود" }),
      textTurn({ ...base, grounding: "grounded", segments: [{ kind: "explanation", text: "إجابة عامة." }] }),
    ]);
    const r = await runTutorTurn({ model, env, history: [], userText: "ما العروض؟" });
    expect(r.answer.grounding).toBe("ungrounded");
    expect(r.answer.segments[0]).toMatchObject({ kind: "notice" });
  });

  it("socratic mode: a reply that completes the exercise is rejected once and regenerated", async () => {
    const { env } = setup({ mode: "socratic" });
    const model = scriptedModel([
      textTurn({ ...base, completesExerciseForStudent: true, grounding: "ungrounded", segments: [{ kind: "explanation", text: "الإجابة: الأولاد." }] }),
      textTurn({ ...base, grounding: "ungrounded", segments: [{ kind: "question", text: "ما الفعل في الجملة؟ ومن الذي قام به؟" }] }),
    ]);
    const r = await runTutorTurn({ model, env, history: [], userText: "حل لي التمرين" });
    expect(r.retried).toBe(true);
    expect(r.fellBack).toBe(false);
    expect(JSON.stringify(r.answer.segments)).not.toContain("الإجابة: الأولاد");
    expect(model.doGenerateCalls).toHaveLength(2);
    const retrySystem = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    expect(retrySystem).toContain("تنبيه من النظام");
  });

  it("falls back to a safe thinking prompt when the model keeps leaking the answer", async () => {
    const { env } = setup({ mode: "assessment" });
    const leak = textTurn({ ...base, completesExerciseForStudent: true, grounding: "ungrounded", segments: [{ kind: "explanation", text: "الحل: س" }] });
    const r = await runTutorTurn({ model: scriptedModel([leak, leak]), env, history: [], userText: "أعطني الحل" });
    expect(r.fellBack).toBe(true);
    expect(r.answer).toEqual(SAFE_FALLBACK);
  });

  it("does not apply the pedagogy guard in explain mode", async () => {
    const { env } = setup({ mode: "explain" });
    const r = await runTutorTurn({
      model: scriptedModel([textTurn({ ...base, completesExerciseForStudent: true, grounding: "ungrounded", segments: [{ kind: "explanation", text: "شرح مباشر" }] })]),
      env, history: [], userText: "اشرح",
    });
    expect(r.retried).toBe(false);
  });

  it("the system prompt carries mode, lesson and page context", async () => {
    const { env } = setup({ mode: "practice", currentPage: 3 });
    const model = scriptedModel([textTurn({ ...base, grounding: "ungrounded", segments: [{ kind: "question", text: "س؟" }] })]);
    await runTutorTurn({ model, env, history: [], userText: "ابدأ" });
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(prompt).toContain("وضع «التدريب»");
    expect(prompt).toContain("الصفحة 3");
  });
});
