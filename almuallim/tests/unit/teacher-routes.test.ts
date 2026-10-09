import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "../helpers/fake-supabase";

const S = vi.hoisted(() => ({ server: null as unknown, admin: null as unknown, audits: [] as unknown[] }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => S.server }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdmin: () => S.admin }));
vi.mock("@/lib/audit", () => ({ audit: async (_c: unknown, e: unknown) => void S.audits.push(e) }));

import { PATCH as validateResponse } from "@/app/api/teacher/responses/[id]/route";
import { PUT as validateMastery } from "@/app/api/teacher/mastery/route";
import { POST as createClass } from "@/app/api/teacher/classes/route";
import { POST as addMembers } from "@/app/api/teacher/classes/[id]/members/route";
import { POST as createUser } from "@/app/api/admin/users/route";

const RID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";
const CID = "33333333-3333-4333-8333-333333333333";
const json = (body: unknown, method = "POST") => new Request("http://x", { method, body: JSON.stringify(body) });

type Handler = Parameters<typeof fakeDb>[0]["handler"];
function server(role: string | null, extra: Handler = () => ({})) {
  const db = fakeDb({
    user: role ? { id: "u1" } : null,
    handler: (op) => {
      if (op.table === "profiles" && op.filters.id === "u1") return { data: { id: "u1", role, display_name: "م", year_group: null, allow_transcript_retention: true } };
      return extra(op);
    },
  });
  S.server = db.client;
  return db;
}
function adminDb(handler: Handler = () => ({})) {
  const writes: { table: string; action: string; values?: unknown }[] = [];
  const db = fakeDb({ user: null, handler: (op) => (op.action !== "select" && writes.push({ table: op.table, action: op.action, values: op.values }), handler(op)) });
  S.admin = db.client;
  return { db, writes };
}
beforeEach(() => { S.audits.length = 0; });

describe("PATCH /api/teacher/responses/[id]", () => {
  const ctx = { params: Promise.resolve({ id: RID }) };
  it("is teacher/admin only", async () => {
    adminDb();
    server(null);
    expect((await validateResponse(json({ teacherScore: 80 }, "PATCH"), ctx)).status).toBe(401);
    server("student");
    expect((await validateResponse(json({ teacherScore: 80 }, "PATCH"), ctx)).status).toBe(403);
  });
  it("validates the score range", async () => {
    adminDb(); server("teacher");
    expect((await validateResponse(json({ teacherScore: 101 }, "PATCH"), ctx)).status).toBe(400);
    expect((await validateResponse(json({ teacherScore: -1 }, "PATCH"), ctx)).status).toBe(400);
  });
  it("404 when RLS hides the response (not this teacher's student) and does not audit", async () => {
    adminDb(); server("teacher", ({ table, action }) => (table === "student_responses" && action === "update" ? { data: null } : {}));
    expect((await validateResponse(json({ teacherScore: 80 }, "PATCH"), ctx)).status).toBe(404);
    expect(S.audits).toHaveLength(0);
  });
  it("saves the teacher score under the teacher's own session and audits", async () => {
    adminDb();
    const db = server("teacher", ({ table, action }) => (table === "student_responses" && action === "update" ? { data: { id: RID, teacher_score: 80, teacher_validated_at: "now" } } : {}));
    const res = await validateResponse(json({ teacherScore: 80, teacherFeedback: "جيد" }, "PATCH"), ctx);
    expect(res.status).toBe(200);
    const upd = db.calls.find((c) => c.table === "student_responses" && c.action === "update")!;
    expect(upd.values).toEqual({ teacher_score: 80, teacher_feedback: "جيد" }); // AI fields are not even sent
    expect(S.audits[0]).toMatchObject({ action: "response.validate", actorId: "u1" });
  });
});

describe("PUT /api/teacher/mastery", () => {
  const body = { studentId: SID, skill: "grammar", lessonId: null, value: 0.7 };
  it("404 for a student the teacher cannot see (RLS)", async () => {
    const a = adminDb(); server("teacher", ({ table }) => (table === "profiles" ? { data: null } : {}));
    expect((await validateMastery(json(body, "PUT"))).status).toBe(404);
    expect(a.writes).toHaveLength(0);
  });
  it("updates an existing row, or creates one when the student has none", async () => {
    server("teacher", ({ table }) => (table === "profiles" ? { data: { id: SID } } : {}));
    const a1 = adminDb(({ table, action }) => (table === "skill_mastery" && action === "select" ? { data: { id: "m1" } } : {}));
    expect((await validateMastery(json(body, "PUT"))).status).toBe(200);
    expect(a1.writes[0]).toMatchObject({ table: "skill_mastery", action: "update", values: { teacher_validated: 0.7 } });
    const a2 = adminDb(() => ({ data: null }));
    server("teacher", ({ table }) => (table === "profiles" ? { data: { id: SID } } : {}));
    expect((await validateMastery(json(body, "PUT"))).status).toBe(200);
    expect(a2.writes[0]).toMatchObject({ action: "insert", values: { student_id: SID, skill: "grammar", ai_estimate: 0, evidence_count: 0, teacher_validated: 0.7 } });
    expect(S.audits.at(-1)).toMatchObject({ action: "mastery.validate" });
  });
  it("clears validation with null and rejects out-of-range values", async () => {
    adminDb(() => ({ data: { id: "m1" } })); server("teacher", ({ table }) => (table === "profiles" ? { data: { id: SID } } : {}));
    expect((await validateMastery(json({ ...body, value: null }, "PUT"))).status).toBe(200);
    expect((await validateMastery(json({ ...body, value: 1.5 }, "PUT"))).status).toBe(400);
    expect((await validateMastery(json({ ...body, skill: "magic" }, "PUT"))).status).toBe(400);
  });
  it("students cannot call it", async () => {
    adminDb(); server("student");
    expect((await validateMastery(json(body, "PUT"))).status).toBe(403);
  });
});

describe("classes", () => {
  it("teachers create classes; students cannot; year range is enforced", async () => {
    adminDb();
    server("student");
    expect((await createClass(json({ name: "٩/أ", yearGroup: 9 }))).status).toBe(403);
    const db = server("teacher", ({ table, action }) => (table === "classes" && action === "insert" ? { data: { id: CID, name: "٩/أ", year_group: 9 } } : {}));
    expect((await createClass(json({ name: "٩/أ", yearGroup: 9 }))).status).toBe(201);
    expect(db.calls.find((c) => c.table === "classes")!.values).toMatchObject({ teacher_id: "u1" }); // always the caller
    expect((await createClass(json({ name: "x", yearGroup: 3 }))).status).toBe(400);
  });
  it("adding members: only to own classes and only real students", async () => {
    const ctx = { params: Promise.resolve({ id: CID }) };
    adminDb(({ table }) => (table === "profiles" ? { data: [{ id: SID }] } : {}));
    server("teacher", ({ table }) => (table === "classes" ? { data: null } : {}));
    expect((await addMembers(json({ studentIds: [SID] }), ctx)).status).toBe(404);
    const a = adminDb(({ table }) => (table === "profiles" ? { data: [{ id: SID }] } : {}));
    server("teacher", ({ table }) => (table === "classes" ? { data: { id: CID, year_group: 9 } } : {}));
    const res = await addMembers(json({ studentIds: [SID, "44444444-4444-4444-8444-444444444444"] }), ctx);
    expect(await res.json()).toEqual({ added: 1, skipped: 1 });
    expect(a.db.calls.some((c) => c.table === "profiles")).toBe(true);
  });
});

describe("POST /api/admin/users", () => {
  function authAdmin(over: { createError?: { status: number } | null; profileError?: boolean } = {}) {
    const deleted: string[] = [];
    const writes: { table: string; action: string; values?: unknown }[] = [];
    const db = fakeDb({ user: null, handler: (op) => (op.action !== "select" && writes.push({ table: op.table, action: op.action, values: op.values }), op.table === "profiles" && op.action === "update" && over.profileError ? { error: { message: "x" } } : {}) });
    S.admin = Object.assign(db.client, {
      auth: { admin: { createUser: async () => (over.createError ? { data: { user: null }, error: over.createError } : { data: { user: { id: SID } }, error: null }), deleteUser: async (id: string) => void deleted.push(id) } },
    });
    return { deleted, writes };
  }
  const valid = { email: "s1@school.test", displayName: "سالم", role: "student", yearGroup: 9, classId: CID, consentRecorded: true };

  it("admin only", async () => {
    authAdmin(); server("teacher");
    expect((await createUser(json(valid))).status).toBe(403);
  });
  it("creates the account, completes the profile, adds to the class, audits, and returns a one-time password", async () => {
    const t = authAdmin(); server("admin");
    const res = await createUser(json(valid));
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.userId).toBe(SID);
    expect(j.temporaryPassword.length).toBeGreaterThanOrEqual(12);
    expect(t.writes.find((w) => w.table === "profiles")!.values).toMatchObject({ role: "student", year_group: 9, display_name: "سالم" });
    expect((t.writes.find((w) => w.table === "profiles")!.values as { consent_recorded_at: string | null }).consent_recorded_at).toBeTruthy();
    expect(t.writes.find((w) => w.table === "class_members")!.values).toEqual({ class_id: CID, student_id: SID });
    expect(S.audits[0]).toMatchObject({ action: "user.create" });
    expect(JSON.stringify(S.audits[0])).not.toContain(j.temporaryPassword);
  });
  it("students need a year group; duplicates map to 409; a failed profile setup rolls the account back", async () => {
    authAdmin(); server("admin");
    expect((await createUser(json({ ...valid, yearGroup: null }))).status).toBe(400);
    authAdmin({ createError: { status: 422 } });
    expect((await createUser(json(valid))).status).toBe(409);
    const t = authAdmin({ profileError: true });
    expect((await createUser(json(valid))).status).toBe(500);
    expect(t.deleted).toEqual([SID]);
  });
});
