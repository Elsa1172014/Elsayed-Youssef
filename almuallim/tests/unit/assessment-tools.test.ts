import { describe, expect, it } from "vitest";
import { executeTool, outcomeFromScore, TurnSink, type AssessmentPersistence, type RubricItem, type ToolEnv } from "@/lib/tutor/tool-core";
import { FakeEmbeddings } from "../helpers/fakes";
import type { Skill, TutorContext } from "@/lib/tutor/types";
import { realtimeToolDefinitions } from "@/lib/voice/session-config";

const ITEM = "22222222-2222-4222-8222-222222222222";
const RUBRIC: RubricItem[] = [{ criterion: "تحديد الفاعل", maxPoints: 2 }, { criterion: "علامة الإعراب", maxPoints: 2 }];

function memoryStore(over: { sessionId?: string | null } = {}) {
  const items = new Map<string, { id: string; skill: Skill; rubric: RubricItem[]; sessionId: string | null }>();
  const created: unknown[] = [];
  const saved: Record<string, unknown>[] = [];
  const p: AssessmentPersistence = {
    async createItem(i) { created.push(i); items.set(ITEM, { id: ITEM, skill: i.skill, rubric: i.rubric, sessionId: over.sessionId === undefined ? "s1" : over.sessionId }); return { itemId: ITEM, ordinal: 0 }; },
    async getItem(id) { return items.get(id) ?? null; },
    async saveResponse(r) { saved.push(r); return { responseId: "resp-1" }; },
  };
  return { p, created, saved, items };
}
const ctx: TutorContext = { sessionId: "s1", studentId: "u1", yearGroup: 9, mode: "practice", level: "core", versionId: "v1", lessonId: "l1", lessonTitle: "د", currentPage: 2, objective: null, mastery: {} };
const envWith = (a?: AssessmentPersistence): ToolEnv => ({ ctx, db: { rpc: async () => ({ data: [], error: null }), from: () => ({}) }, embeddings: new FakeEmbeddings(), sink: new TurnSink(), assessments: a });

const propose = { skill: "grammar", prompt: "ما الفاعل في: كتب الطالب الدرس؟", rubric: RUBRIC.map((r) => ({ criterion: r.criterion, maxPoints: r.maxPoints })), hints: ["انظر إلى الفعل أولًا"], sourceChunkIds: ["ck1", "ghost"] };

describe("propose_question", () => {
  it("stores the item with its rubric/hints and keeps only chunk ids actually retrieved this turn", async () => {
    const m = memoryStore();
    const env = envWith(m.p);
    env.sink.addPassages([{ chunkId: "ck1", lessonId: "l1", lessonTitle: "د", pageStart: 2, pageEnd: 2, content: "x", vectorSimilarity: 1, lexicalScore: 1, fusedScore: 1 }], "strong");
    const out = (await executeTool(env, "propose_question", propose)) as { itemId: string; instruction: string };
    expect(out.itemId).toBe(ITEM);
    expect(out.instruction).toContain("لا تذكر معايير التقييم");
    expect(m.created[0]).toMatchObject({ skill: "grammar", level: "core", sourceChunkIds: ["ck1"] });
  });
  it("validates input and degrades gracefully without storage", async () => {
    await expect(executeTool(envWith(memoryStore().p), "propose_question", { ...propose, rubric: [] })).rejects.toThrow();
    expect(await executeTool(envWith(undefined), "propose_question", propose)).toMatchObject({ error: "assessment_storage_unavailable" });
  });
});

describe("evaluate_response", () => {
  async function ready(over?: Parameters<typeof memoryStore>[0]) {
    const m = memoryStore(over);
    const env = envWith(m.p);
    await executeTool(env, "propose_question", propose);
    return { m, env };
  }
  const evalInput = (points: { criterion: string; points: number }[], extra: Record<string, unknown> = {}) => ({ itemId: ITEM, studentAnswer: "الطالب فاعل مرفوع", feedback: "أحسنت في تحديد الفاعل", points, ...extra });

  it("computes the score from the rubric, derives the outcome itself, saves the response and records evidence — without returning a grade", async () => {
    const { m, env } = await ready();
    const out = await executeTool(env, "evaluate_response", evalInput([{ criterion: "تحديد الفاعل", points: 2 }, { criterion: "علامة الإعراب", points: 1 }], { hintsUsed: 1, misconception: "خلط بين الفاعل والمفعول" }));
    expect(out).toMatchObject({ recorded: true, outcome: "partial" });
    expect(JSON.stringify(out)).not.toMatch(/75|score|درجة/);
    expect(m.saved[0]).toMatchObject({ itemId: ITEM, aiScore: 75, hintsUsed: 1, misconception: "خلط بين الفاعل والمفعول", aiFeedback: "أحسنت في تحديد الفاعل" });
    expect(m.saved[0]!.aiRubric).toEqual([{ criterion: "تحديد الفاعل", points: 2, max: 2 }, { criterion: "علامة الإعراب", points: 1, max: 2 }]);
    expect(env.sink.evidence).toEqual([{ skill: "grammar", outcome: "partial", hintsUsed: 1, misconception: "خلط بين الفاعل والمفعول" }]);
  });

  it("rejects scores that don't follow the fixed rubric (unknown criterion, missing criterion, points above max)", async () => {
    const { m, env } = await ready();
    expect(await executeTool(env, "evaluate_response", evalInput([{ criterion: "معيار مخترع", points: 1 }, { criterion: "تحديد الفاعل", points: 1 }]))).toMatchObject({ error: "rubric_mismatch" });
    expect(await executeTool(env, "evaluate_response", evalInput([{ criterion: "تحديد الفاعل", points: 2 }]))).toMatchObject({ error: "rubric_mismatch" });
    expect(await executeTool(env, "evaluate_response", evalInput([{ criterion: "تحديد الفاعل", points: 5 }, { criterion: "علامة الإعراب", points: 0 }]))).toMatchObject({ error: "points_exceed_max" });
    expect(m.saved).toHaveLength(0);
    expect(env.sink.evidence).toHaveLength(0);
  });

  it("refuses items from another session or unknown items", async () => {
    const { env } = await ready({ sessionId: "other-session" });
    expect(await executeTool(env, "evaluate_response", evalInput([{ criterion: "تحديد الفاعل", points: 2 }, { criterion: "علامة الإعراب", points: 2 }]))).toMatchObject({ error: "item_not_found" });
    const e2 = envWith(memoryStore().p);
    expect(await executeTool(e2, "evaluate_response", evalInput([{ criterion: "x", points: 1 }]))).toMatchObject({ error: "item_not_found" });
  });

  it("outcome thresholds", () => {
    expect([100, 85, 84.9, 40, 39.9, 0].map(outcomeFromScore)).toEqual(["correct", "correct", "partial", "partial", "incorrect", "incorrect"]);
  });
});

describe("tool catalogue consistency", () => {
  it("the realtime tool definitions cover exactly the server-executable tools", () => {
    expect(realtimeToolDefinitions().map((t) => t.name).sort()).toEqual(["evaluate_response", "get_lesson_outline", "get_page", "propose_question", "record_evidence", "search_textbook"]);
    const ev = realtimeToolDefinitions().find((t) => t.name === "evaluate_response")!.parameters as { required: string[] };
    expect(ev.required).toEqual(expect.arrayContaining(["itemId", "studentAnswer", "points", "feedback"]));
  });
});
