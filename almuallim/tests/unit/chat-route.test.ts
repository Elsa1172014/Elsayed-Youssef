import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "../helpers/fake-supabase";
import { FakeEmbeddings } from "../helpers/fakes";
import { scriptedModel, textTurn, toolTurn } from "../helpers/mock-model";

const S = vi.hoisted(() => ({
  server: null as unknown, admin: null as unknown, model: null as unknown,
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => S.server }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdmin: () => S.admin }));
vi.mock("@/lib/providers/models", () => ({ getTutorModel: () => S.model, getEmbeddings: () => new FakeEmbeddings() }));
vi.mock("@/lib/env", () => ({
  EnvError: class EnvError extends Error {},
  serverEnv: () => ({ RATE_LIMIT_CHAT_PER_MIN: 20, BUDGET_TUTOR_TOKENS_PER_USER_DAY: 1000, BUDGET_GLOBAL_TUTOR_TOKENS_PER_DAY: 5000 }),
}));

import { POST } from "@/app/api/tutor/chat/route";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CHUNK = "الفاعل اسم مرفوع يدل على من قام بالفعل أو اتصف به، ويأتي بعد الفعل مباشرة.";
const answerJson = (grounding = "grounded") => ({
  segments: [{ kind: "quote", chunkId: "ck", text: "الفاعل اسم مرفوع" }, { kind: "question", text: "من الفاعل في: كتب الطالب؟" }],
  grounding, completesExerciseForStudent: false, detectedMisconception: null, suggestedNextStep: null,
});

interface Opts { user?: boolean; retain?: boolean; owner?: string; rateOk?: boolean; used?: number; model?: unknown; evidence?: boolean }
function setup(o: Opts = {}) {
  const userId = "stud-1";
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const server = fakeDb({
    user: o.user === false ? null : { id: userId },
    handler: ({ table }) => {
      if (table === "profiles") return { data: { id: userId, role: "student", display_name: "ط", year_group: 9, allow_transcript_retention: o.retain ?? true } };
      if (table === "tutoring_sessions") return { data: { id: SESSION_ID, student_id: o.owner ?? userId, mode: "explain", level: "core", book_version_id: "v1", lesson_id: "l1", current_page: 2, objective: null, status: "active", channel: "text" } };
      if (table === "lessons") return { data: { title: "الدرس الأول: الفاعل" } };
      if (table === "skill_mastery") return { data: [] };
      if (table === "session_events") return { data: [] };
      return {};
    },
    rpc: (name, args) => {
      if (name === "append_session_event") { const a = args as { p_type: string; p_payload: Record<string, unknown> }; events.push({ type: a.p_type, payload: a.p_payload }); return {}; }
      if (name === "search_content") return { data: [{ chunk_id: "ck", lesson_id: "l1", lesson_title: "الدرس الأول: الفاعل", page_start: 2, page_end: 3, content: CHUNK, vector_similarity: 0.6, lexical_score: 0.2, fused_score: 0.03 }] };
      return {};
    },
  });
  const adminWrites: { table: string; action: string; values?: unknown }[] = [];
  const admin = fakeDb({
    user: null,
    handler: ({ table, action, values }) => {
      if (action !== "select") adminWrites.push({ table, action, values });
      return table === "skill_mastery" ? { data: null } : {};
    },
    rpc: (name) => (name === "rate_limit_hit" ? { data: o.rateOk ?? true } : name === "usage_sum" ? { data: o.used ?? 0 } : {}),
  });
  S.server = server.client;
  S.admin = admin.client;
  S.model = o.model ?? scriptedModel([toolTurn("search_textbook", { query: "الفاعل" }), textTurn(answerJson())]);
  return { events, adminWrites, server, admin };
}
const post = (body: unknown) => POST(new Request("http://x/api/tutor/chat", { method: "POST", body: JSON.stringify(body) }));
const valid = { sessionId: SESSION_ID, text: "ما هو الفاعل؟" };

beforeEach(() => vi.clearAllMocks());

describe("POST /api/tutor/chat", () => {
  it("401 for anonymous callers", async () => { setup({ user: false }); expect((await post(valid)).status).toBe(401); });
  it("400 on invalid input", async () => {
    setup();
    expect((await post({ sessionId: "x", text: "hi" })).status).toBe(400);
    expect((await post({ sessionId: SESSION_ID, text: "" })).status).toBe(400);
    expect((await post({ sessionId: SESSION_ID, text: "x".repeat(2001) })).status).toBe(400);
  });
  it("429 when the per-user rate limit is hit, before any provider call", async () => {
    const m = scriptedModel([]);
    setup({ rateOk: false, model: m });
    const res = await post(valid);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(m.doGenerateCalls).toHaveLength(0);
  });
  it("429 when the daily budget is exhausted, before any provider call", async () => {
    const m = scriptedModel([]);
    setup({ used: 1000, model: m });
    expect((await post(valid)).status).toBe(429);
    expect(m.doGenerateCalls).toHaveLength(0);
  });
  it("404 for a session owned by someone else", async () => {
    setup({ owner: "other-student" });
    expect((await post(valid)).status).toBe(404);
  });
  it("returns a verified answer, persists both turns and records usage", async () => {
    const t = setup();
    const res = await post(valid);
    expect(res.status).toBe(200);
    const { answer } = await res.json();
    expect(answer.grounding).toBe("grounded");
    expect(answer.segments[0]).toMatchObject({ kind: "quote", source: { label: "ص ٢–٣" } });
    expect(t.events.map((e) => e.type)).toEqual(["user_text", "assistant_text"]);
    expect(t.events[0]!.payload.text).toBe("ما هو الفاعل؟");
    expect(t.adminWrites.filter((w) => w.table === "usage_ledger").length).toBeGreaterThanOrEqual(1);
  });
  it("does not retain transcript text when the student opted out", async () => {
    const t = setup({ retain: false });
    await post(valid);
    for (const e of t.events) {
      expect(e.payload.text).toBeUndefined();
      expect(e.payload.answer).toBeUndefined();
      expect(e.payload.redacted).toBe(true);
    }
  });
  it("502 with a friendly error (and an error event) when the provider fails", async () => {
    const failing = scriptedModel([]);
    failing.doGenerate = async () => { throw new Error("provider down"); };
    const t = setup({ model: failing });
    const res = await post(valid);
    expect(res.status).toBe(502);
    expect(t.events.at(-1)!.type).toBe("error");
  });
  it("folds tutor-recorded evidence into skill mastery (server-written)", async () => {
    const t = setup({
      model: scriptedModel([
        toolTurn("record_evidence", { skill: "grammar", outcome: "correct", hintsUsed: 1 }),
        textTurn({ ...answerJson("ungrounded"), segments: [{ kind: "question", text: "أحسنت! والآن: ما إعراب الفاعل؟" }] }),
      ]),
    });
    await post(valid);
    const w = t.adminWrites.find((x) => x.table === "skill_mastery");
    expect(w?.action).toBe("insert");
    expect(w?.values).toMatchObject({ student_id: "stud-1", skill: "grammar", lesson_id: "l1", evidence_count: 1 });
  });
});
