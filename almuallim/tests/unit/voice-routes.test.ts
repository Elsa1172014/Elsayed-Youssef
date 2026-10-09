import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "../helpers/fake-supabase";
import { FakeEmbeddings } from "../helpers/fakes";

const S = vi.hoisted(() => ({ server: null as unknown, admin: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => S.server }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdmin: () => S.admin }));
vi.mock("@/lib/providers/models", () => ({ getEmbeddings: () => new FakeEmbeddings() }));
vi.mock("@/lib/env", () => ({
  EnvError: class EnvError extends Error {},
  serverEnv: () => ({
    OPENAI_API_KEY: "sk-server-secret-key", REALTIME_MODEL: "gpt-realtime", REALTIME_VOICE: "marin", REALTIME_TRANSCRIBE_MODEL: "gpt-4o-mini-transcribe",
    RATE_LIMIT_REALTIME_TOKEN_PER_HOUR: 10, RATE_LIMIT_CHAT_PER_MIN: 20, BUDGET_REALTIME_SECONDS_PER_USER_DAY: 3600,
  }),
}));

import { POST as token } from "@/app/api/realtime/token/route";
import { POST as tool } from "@/app/api/realtime/tool/route";
import { POST as events } from "@/app/api/realtime/events/route";

const SID = "11111111-1111-4111-8111-111111111111";
const CHUNK = "الفاعل اسم مرفوع يدل على من قام بالفعل.";

interface Opts { user?: boolean; owner?: string; rateOk?: boolean; used?: number; currentPage?: number | null; retain?: boolean; openStartedAt?: string | null }
function setup(o: Opts = {}) {
  const evs: { type: string; payload: Record<string, unknown> }[] = [];
  const adminWrites: { table: string; values: unknown }[] = [];
  const server = fakeDb({
    user: o.user === false ? null : { id: "stud-1" },
    handler: ({ table, action }) => {
      if (table === "profiles") return { data: { id: "stud-1", role: "student", display_name: "ط", year_group: 9, allow_transcript_retention: o.retain ?? true } };
      if (table === "tutoring_sessions" && action === "select") return { data: { id: SID, student_id: o.owner ?? "stud-1", mode: "explain", level: "core", book_version_id: "v1", lesson_id: "l1", current_page: o.currentPage === undefined ? null : o.currentPage, objective: null, status: "active", channel: "text" } };
      if (table === "lessons") return { data: { title: "الدرس الأول", learning_objectives: [], verified_at: null } };
      if (table === "skill_mastery") return { data: [] };
      if (table === "book_versions") return { data: { books: { title: "لغتي" } } };
      if (table === "session_events") return { data: o.openStartedAt ? [{ payload: { voice: "started" }, created_at: o.openStartedAt, seq: 3 }] : [] };
      return {};
    },
    rpc: (name, args) => {
      if (name === "append_session_event") { const a = args as { p_type: string; p_payload: Record<string, unknown> }; evs.push({ type: a.p_type, payload: a.p_payload }); return {}; }
      if (name === "get_page_text") return { data: [{ page_number: 2, printed_label: "2", text: "نص الصفحة الثانية عن الفاعل", lesson_id: "l1", lesson_title: "الدرس الأول" }] };
      if (name === "search_content") return { data: [{ chunk_id: "ck", lesson_id: "l1", lesson_title: "الدرس الأول", page_start: 2, page_end: 2, content: CHUNK, vector_similarity: 0.6, lexical_score: 0.2, fused_score: 0.03 }] };
      return {};
    },
  });
  const admin = fakeDb({
    user: null,
    handler: ({ table, action, values }) => (action !== "select" && adminWrites.push({ table, values }), {}),
    rpc: (n) => (n === "rate_limit_hit" ? { data: o.rateOk ?? true } : n === "usage_sum" ? { data: o.used ?? 0 } : {}),
  });
  S.server = server.client;
  S.admin = admin.client;
  return { evs, adminWrites, server };
}
const post = (fn: (r: Request) => Promise<Response>, body: unknown) => fn(new Request("http://x", { method: "POST", body: JSON.stringify(body) }));
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ value: "ek_short_lived", expires_at: 1234567890 }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("POST /api/realtime/token", () => {
  it("401 anonymous; 400 invalid id; 404 foreign session", async () => {
    setup({ user: false });
    expect((await post(token, { sessionId: SID })).status).toBe(401);
    setup();
    expect((await post(token, { sessionId: "nope" })).status).toBe(400);
    setup({ owner: "other" });
    expect((await post(token, { sessionId: SID })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("429 on rate limit or exhausted daily voice budget, before contacting the provider", async () => {
    setup({ rateOk: false });
    expect((await post(token, { sessionId: SID })).status).toBe(429);
    setup({ used: 3600 });
    expect((await post(token, { sessionId: SID })).status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("mints a short-lived secret server-side and NEVER returns the permanent key", async () => {
    const t = setup({ currentPage: 2 });
    const res = await post(token, { sessionId: SID });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sk-server-secret-key");
    const j = JSON.parse(text);
    expect(j).toMatchObject({ clientSecret: "ek_short_lived", model: "gpt-realtime", callsUrl: "https://api.openai.com/v1/realtime/calls" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect(init.headers.Authorization).toBe("Bearer sk-server-secret-key");
    const sent = JSON.parse(init.body);
    expect(sent.expires_after).toEqual({ anchor: "created_at", seconds: 120 });
    expect(sent.session).toMatchObject({ type: "realtime", model: "gpt-realtime", audio: { output: { voice: "marin" }, input: { transcription: { language: "ar" } } } });
    expect(sent.session.tools.map((x: { name: string }) => x.name)).toEqual(["search_textbook", "get_page", "get_lesson_outline", "propose_question", "evaluate_response", "record_evidence"]);
    expect(sent.session.instructions).toContain("المحادثة الصوتية");
    expect(sent.session.instructions).toContain("نص الصفحة الثانية عن الفاعل"); // confirmed page context is injected
    expect(t.evs).toContainEqual({ type: "state", payload: { voice: "started" } });
  });
  it("charges an abandoned earlier voice segment (capped) before issuing a new token", async () => {
    const t = setup({ openStartedAt: new Date(Date.now() - 3 * 3600_000).toISOString() });
    await post(token, { sessionId: SID });
    const w = t.adminWrites.find((x) => x.table === "usage_ledger");
    expect(w?.values).toMatchObject({ user_id: "stud-1", kind: "realtime_seconds", amount: 600 });
  });
  it("502 with a friendly message when the provider rejects the request", async () => {
    setup();
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    const res = await post(token, { sessionId: SID });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("nope");
  });
});

describe("POST /api/realtime/tool", () => {
  const call = (name: string, args: unknown) => post(tool, { sessionId: SID, name, arguments: args, callId: "c1" });
  it("rejects unknown tool names and foreign sessions", async () => {
    setup();
    expect((await call("delete_everything", {})).status).toBe(400);
    setup({ owner: "x" });
    expect((await call("search_textbook", { query: "الفاعل" })).status).toBe(404);
  });
  it("runs search_textbook server-side under the user's identity and returns passages with page labels", async () => {
    const t = setup();
    const res = await call("search_textbook", JSON.stringify({ query: "ما هو الفاعل" }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    const out = JSON.parse(j.output);
    expect(out.passages[0]).toMatchObject({ chunkId: "ck", pages: "ص ٢" });
    expect(t.server.client.rpc).toHaveBeenCalledWith("search_content", expect.objectContaining({ p_book_version_id: "v1" }));
  });
  it("returns an error payload (HTTP 200) for malformed arguments or invalid input so the conversation can recover", async () => {
    setup();
    const bad = await (await call("search_textbook", "{not json")).json();
    expect(bad.ok).toBe(false);
    expect(JSON.parse(bad.output).error).toBe("invalid_arguments");
    const invalid = await (await call("get_page", { pageNumber: -5 })).json();
    expect(invalid.ok).toBe(false);
  });
  it("records evidence into server-written mastery", async () => {
    const t = setup();
    await call("record_evidence", { skill: "grammar", outcome: "correct", hintsUsed: 0 });
    expect(t.adminWrites.find((w) => w.table === "skill_mastery")?.values).toMatchObject({ student_id: "stud-1", skill: "grammar", evidence_count: 1 });
  });
});

describe("POST /api/realtime/events", () => {
  it("stores transcripts and honours the transcript-retention opt-out", async () => {
    const t = setup({ retain: false });
    const res = await post(events, { sessionId: SID, events: [{ type: "user_speech", text: "ما هو الفاعل؟" }, { type: "assistant_speech", text: "الفاعل اسم مرفوع", interrupted: true }] });
    expect(res.status).toBe(200);
    expect(t.evs.map((e) => e.type)).toEqual(["user_speech", "assistant_speech"]);
    for (const e of t.evs) { expect(e.payload.text).toBeUndefined(); expect(e.payload.redacted).toBe(true); }
  });
  it("ignores a client-sent 'started' (server stamps it) and charges measured time on 'ended'", async () => {
    const t = setup({ openStartedAt: new Date(Date.now() - 90_000).toISOString() });
    await post(events, { sessionId: SID, events: [{ type: "state", voice: "started" }, { type: "state", voice: "ended" }] });
    expect(t.evs.filter((e) => e.type === "state").map((e) => e.payload.voice)).toEqual(["ended"]);
    const w = t.adminWrites.find((x) => x.table === "usage_ledger")!;
    expect(w.values).toMatchObject({ kind: "realtime_seconds" });
    const amount = (w.values as { amount: number }).amount;
    expect(amount).toBeGreaterThanOrEqual(89);
    expect(amount).toBeLessThanOrEqual(100);
  });
  it("validates the batch (unknown types and oversize batches are rejected)", async () => {
    setup();
    expect((await post(events, { sessionId: SID, events: [{ type: "evil", text: "x" }] })).status).toBe(400);
    expect((await post(events, { sessionId: SID, events: Array.from({ length: 21 }, () => ({ type: "error", code: "x" })) })).status).toBe(400);
  });
});
