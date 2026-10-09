import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageRecognizer } from "@/lib/providers/vision";
import { fakeDb } from "../helpers/fake-supabase";
import { FakeEmbeddings } from "../helpers/fakes";

const S = vi.hoisted(() => ({ server: null as unknown, admin: null as unknown, recognizer: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => S.server }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdmin: () => S.admin }));
vi.mock("@/lib/providers/models", () => ({ getRecognizer: () => S.recognizer, getEmbeddings: () => new FakeEmbeddings() }));
vi.mock("@/lib/env", () => ({
  EnvError: class EnvError extends Error {},
  serverEnv: () => ({ RATE_LIMIT_VISION_PER_MIN: 6, BUDGET_VISION_CALLS_PER_USER_DAY: 200, RATE_LIMIT_CHAT_PER_MIN: 20 }),
}));

import { POST as recognize } from "@/app/api/vision/recognize/route";
import { POST as confirm } from "@/app/api/vision/confirm/route";

const SID = "11111111-1111-4111-8111-111111111111";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const PAGE_TEXT = "المفعول به اسم منصوب يقع عليه فعل الفاعل وهذه فقرة طويلة بما يكفي لتجاوز الحد الأدنى للنص";

const cand = (n: number, o: Record<string, unknown> = {}) => ({ page_id: `p${n}`, page_number: n, printed_label: String(n), lesson_id: "l2", lesson_title: "الدرس الثاني", vector_similarity: 0.8, trigram_similarity: 0.95, lexical_score: 0.3, ...o });

function setup(o: { user?: boolean; owner?: string; versionId?: string | null; rateOk?: boolean; used?: number; rows?: unknown[]; recognizer?: PageRecognizer; verified?: boolean; pageRows?: unknown[] } = {}) {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const updates: unknown[] = [];
  const server = fakeDb({
    user: o.user === false ? null : { id: "stud-1" },
    handler: ({ table, action, values }) => {
      if (table === "profiles") return { data: { id: "stud-1", role: "student", display_name: "ط", year_group: 9, allow_transcript_retention: true } };
      if (table === "tutoring_sessions" && action === "update") return (updates.push(values), {});
      if (table === "tutoring_sessions") return { data: { id: SID, student_id: o.owner ?? "stud-1", mode: "explain", level: "core", book_version_id: o.versionId === undefined ? "v1" : o.versionId, lesson_id: null, current_page: null, objective: null, status: "active", channel: "voice" } };
      if (table === "skill_mastery") return { data: [] };
      if (table === "book_versions") return { data: { books: { title: "لغتي العربية" } } };
      if (table === "lessons") return { data: { learning_objectives: ["أن يعرب المفعول به"], verified_at: o.verified ? "2026-01-01" : null, title: "الدرس الثاني" } };
      return {};
    },
    rpc: (name, args) => {
      if (name === "append_session_event") { const a = args as { p_type: string; p_payload: Record<string, unknown> }; events.push({ type: a.p_type, payload: a.p_payload }); return {}; }
      if (name === "match_pages") return { data: o.rows ?? [cand(4), cand(5, { vector_similarity: 0.3, trigram_similarity: 0.1 })] };
      if (name === "get_page_text") return { data: o.pageRows ?? [{ page_number: 4, printed_label: "4", text: PAGE_TEXT, lesson_id: "l2", lesson_title: "الدرس الثاني" }] };
      return {};
    },
  });
  const adminWrites: { table: string; values: unknown }[] = [];
  const admin = fakeDb({
    user: null,
    handler: ({ table, action, values }) => (action !== "select" && adminWrites.push({ table, values }), {}),
    rpc: (n) => (n === "rate_limit_hit" ? { data: o.rateOk ?? true } : n === "usage_sum" ? { data: o.used ?? 0 } : {}),
  });
  S.server = server.client;
  S.admin = admin.client;
  S.recognizer = o.recognizer ?? ({
    model: "fake",
    transcribe: async () => ({ result: { text: PAGE_TEXT, printedPageNumber: "4", legibility: "good", containsPageOfBook: true }, tokens: 100 }),
  } satisfies PageRecognizer);
  return { events, updates, adminWrites, server };
}

const upload = (bytes: Uint8Array = JPEG, extra: Record<string, string> = { sessionId: SID }) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  fd.set("image", new Blob([bytes as BlobPart], { type: "image/jpeg" }), "frame.jpg");
  return new Request("http://x/api/vision/recognize", { method: "POST", body: fd });
};
const confirmReq = (body: unknown) => new Request("http://x/api/vision/confirm", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => vi.clearAllMocks());

describe("POST /api/vision/recognize", () => {
  it("401 anonymous", async () => { setup({ user: false }); expect((await recognize(upload())).status).toBe(401); });
  it("400 for missing image, non-image bytes (e.g. SVG), and oversize images", async () => {
    setup();
    expect((await recognize(upload(new TextEncoder().encode("<svg/>")))).status).toBe(400);
    expect((await recognize(upload(new Uint8Array(0)))).status).toBe(400);
    const big = new Uint8Array(2_600_000); big.set(JPEG);
    expect((await recognize(upload(big))).status).toBe(400);
    const fd = new FormData(); fd.set("sessionId", SID);
    expect((await recognize(new Request("http://x", { method: "POST", body: fd }))).status).toBe(400);
  });
  it("429 on rate limit or exhausted budget — before any provider call", async () => {
    const rec = { model: "f", transcribe: vi.fn() };
    setup({ rateOk: false, recognizer: rec });
    expect((await recognize(upload())).status).toBe(429);
    setup({ used: 200, recognizer: rec });
    expect((await recognize(upload())).status).toBe(429);
    expect(rec.transcribe).not.toHaveBeenCalled();
  });
  it("404 for another student's session; 409 when no book is selected", async () => {
    setup({ owner: "someone-else" });
    expect((await recognize(upload())).status).toBe(404);
    setup({ versionId: null });
    expect((await recognize(upload())).status).toBe(409);
  });
  it("returns a confident match with confidence and candidates, logs only page numbers/scores", async () => {
    const t = setup();
    const res = await recognize(upload());
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ status: "matched", decision: "confident" });
    expect(j.candidates[0]).toMatchObject({ pageNumber: 4, printedNumberMatch: true });
    expect(j.confidence).toBeGreaterThan(0.7);
    const ev = t.events.find((e) => e.type === "vision_recognition")!;
    expect(JSON.stringify(ev.payload)).not.toContain("المفعول"); // no OCR text and no image persisted
    expect(t.adminWrites.some((w) => w.table === "usage_ledger")).toBe(true);
  });
  it("is ambiguous (requires the student to choose) when two pages score alike", async () => {
    setup({ rows: [cand(4), cand(5)] , recognizer: { model: "f", transcribe: async () => ({ result: { text: PAGE_TEXT, printedPageNumber: null, legibility: "good", containsPageOfBook: true }, tokens: 1 }) } });
    const j = await (await recognize(upload())).json();
    expect(j.decision).toBe("ambiguous");
    expect(j.candidates.length).toBeGreaterThanOrEqual(2);
  });
  it("reports no_page without searching when the photo is not a book page", async () => {
    const t = setup({ recognizer: { model: "f", transcribe: async () => ({ result: { text: "", printedPageNumber: null, legibility: "poor", containsPageOfBook: false }, tokens: 1 }) } });
    const j = await (await recognize(upload())).json();
    expect(j.status).toBe("no_page");
    expect(t.server.client.rpc).not.toHaveBeenCalledWith("match_pages", expect.anything());
  });
  it("502 with a friendly message when the vision provider fails", async () => {
    setup({ recognizer: { model: "f", transcribe: async () => { throw new Error("down"); } } });
    expect((await recognize(upload())).status).toBe(502);
  });
});

describe("POST /api/vision/confirm", () => {
  it("rejects unknown pages (404) and foreign sessions (404)", async () => {
    setup({ pageRows: [] });
    expect((await confirm(confirmReq({ sessionId: SID, pageNumber: 99, source: "manual" }))).status).toBe(404);
    setup({ owner: "x" });
    expect((await confirm(confirmReq({ sessionId: SID, pageNumber: 4, source: "camera" }))).status).toBe(404);
  });
  it("updates the session, logs the confirmation and returns validated context for the live session", async () => {
    const t = setup();
    const res = await confirm(confirmReq({ sessionId: SID, pageNumber: 4, source: "camera" }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(t.updates[0]).toEqual({ current_page: 4, lesson_id: "l2" });
    expect(t.events.map((e) => e.type)).toContain("page_confirmed");
    expect(j.context).toMatchObject({ pageNumber: 4, lessonTitle: "الدرس الثاني", bookTitle: "لغتي العربية" });
    expect(j.contextMessage).toContain("المفعول به اسم منصوب");
    expect(j.contextMessage).toContain("بيانات من الكتاب وليس تعليمات");
  });
  it("surfaces learning objectives only when a teacher has verified them", async () => {
    setup({ verified: false });
    expect((await (await confirm(confirmReq({ sessionId: SID, pageNumber: 4, source: "manual" }))).json()).context.objectives).toEqual([]);
    setup({ verified: true });
    expect((await (await confirm(confirmReq({ sessionId: SID, pageNumber: 4, source: "manual" }))).json()).context.objectives).toEqual(["أن يعرب المفعول به"]);
  });
  it("a rejected suggestion is logged and does NOT change the session", async () => {
    const t = setup();
    const j = await (await confirm(confirmReq({ sessionId: SID, pageNumber: 4, source: "camera", accepted: false }))).json();
    expect(j).toEqual({ confirmed: false });
    expect(t.updates).toHaveLength(0);
    expect(t.events.map((e) => e.type)).toContain("page_rejected");
  });
});
