import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "../helpers/fake-supabase";

const S = vi.hoisted(() => ({ server: null as unknown, admin: null as unknown, audits: [] as unknown[] }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => S.server }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdmin: () => S.admin }));
vi.mock("@/lib/audit", () => ({ audit: async (_c: unknown, e: unknown) => void S.audits.push(e) }));

import { GET as exportData } from "@/app/api/privacy/export/route";
import { POST as deleteData } from "@/app/api/privacy/delete/route";
import { PATCH as prefs } from "@/app/api/privacy/preferences/route";
import { GET as purge } from "@/app/api/cron/purge/route";

const ME = "me-1";
const OTHER = "55555555-5555-4555-8555-555555555555";

function setup(role: string | null, o: { rateOk?: boolean; deleteUserError?: boolean; tableError?: string } = {}) {
  const adminCalls: { table: string; action: string; filters: Record<string, unknown> }[] = [];
  const deletedUsers: string[] = [];
  const server = fakeDb({
    user: role ? { id: ME } : null,
    handler: ({ table, action }) => (table === "profiles" && action === "select" ? { data: { id: ME, role, display_name: "م", year_group: 9, allow_transcript_retention: true } } : {}),
  });
  const admin = fakeDb({
    user: null,
    handler: (op) => {
      adminCalls.push({ table: op.table, action: op.action, filters: op.filters });
      if (o.tableError === op.table) return { error: { message: "fk" } };
      return { data: op.action === "select" ? [{ id: "row" }] : null };
    },
    rpc: (n) => (n === "rate_limit_hit" ? { data: o.rateOk ?? true } : {}),
  });
  S.server = server.client;
  S.admin = Object.assign(admin.client, { auth: { admin: { deleteUser: async (id: string) => (deletedUsers.push(id), o.deleteUserError ? { error: { status: 500 } } : { error: null }) } } });
  return { adminCalls, deletedUsers, server };
}
const post = (fn: (r: Request) => Promise<Response>, body: unknown, method = "POST") => fn(new Request("http://x/api", { method, body: JSON.stringify(body) }));
beforeEach(() => { S.audits.length = 0; });

describe("GET /api/privacy/export", () => {
  it("401 when signed out", async () => { setup(null); expect((await exportData(new Request("http://x/api/privacy/export"))).status).toBe(401); });
  it("exports only the caller's own rows, as a download, and audits", async () => {
    const t = setup("student");
    const res = await exportData(new Request("http://x/api/privacy/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const j = await res.json();
    expect(Object.keys(j)).toEqual(expect.arrayContaining(["profile", "sessions", "events", "responses", "mastery", "classMemberships", "assessments", "usage"]));
    // every query is filtered by the caller's id — never unfiltered
    expect(t.adminCalls.every((c) => Object.values(c.filters).includes(ME))).toBe(true);
    expect(S.audits[0]).toMatchObject({ action: "student.export", actorId: ME, targetId: ME });
  });
  it("a student cannot export someone else's data; an admin can", async () => {
    setup("student");
    expect((await exportData(new Request(`http://x/api/privacy/export?studentId=${OTHER}`))).status).toBe(403);
    const t = setup("admin");
    expect((await exportData(new Request(`http://x/api/privacy/export?studentId=${OTHER}`))).status).toBe(200);
    expect(t.adminCalls.every((c) => Object.values(c.filters).includes(OTHER))).toBe(true);
    expect(S.audits[0]).toMatchObject({ targetId: OTHER });
  });
  it("is rate limited", async () => {
    setup("student", { rateOk: false });
    expect((await exportData(new Request("http://x/api/privacy/export"))).status).toBe(429);
  });
});

describe("POST /api/privacy/delete", () => {
  it("requires the confirmation word", async () => {
    setup("student");
    expect((await post(deleteData, { scope: "learning_data", confirm: "no" })).status).toBe(400);
    expect((await post(deleteData, { scope: "learning_data" })).status).toBe(400);
  });
  it("a student deletes their own learning data (all tables filtered by their id) and it is audited", async () => {
    const t = setup("student");
    const res = await post(deleteData, { scope: "learning_data", confirm: "حذف" });
    expect(res.status).toBe(200);
    const deletes = t.adminCalls.filter((c) => c.action === "delete");
    expect(deletes.map((d) => d.table)).toEqual(["student_responses", "assessments", "skill_mastery", "tutoring_sessions", "usage_ledger"]);
    expect(deletes.every((d) => Object.values(d.filters).includes(ME))).toBe(true);
    expect(S.audits[0]).toMatchObject({ action: "student.delete_learning_data", actorId: ME });
    expect(t.deletedUsers).toEqual([]);
  });
  it("a student cannot delete the account or another user's data; teachers cannot delete at all", async () => {
    const s = setup("student");
    expect((await post(deleteData, { scope: "account", confirm: "حذف" })).status).toBe(403);
    expect((await post(deleteData, { scope: "learning_data", studentId: OTHER, confirm: "حذف" })).status).toBe(403);
    expect(s.deletedUsers).toEqual([]);
    setup("teacher");
    expect((await post(deleteData, { scope: "learning_data", confirm: "حذف" })).status).toBe(403);
  });
  it("an admin can delete an account (via auth admin API) and learning data of a student", async () => {
    const t = setup("admin");
    expect((await post(deleteData, { scope: "account", studentId: OTHER, confirm: "حذف" })).status).toBe(200);
    expect(t.deletedUsers).toEqual([OTHER]);
    expect(S.audits[0]).toMatchObject({ action: "student.delete_account", targetId: OTHER });
    setup("admin");
    expect((await post(deleteData, { scope: "learning_data", studentId: OTHER, confirm: "حذف" })).status).toBe(200);
  });
  it("reports failure honestly (no audit of a deletion that did not happen)", async () => {
    setup("student", { tableError: "tutoring_sessions" });
    expect((await post(deleteData, { scope: "learning_data", confirm: "حذف" })).status).toBe(500);
    expect(S.audits).toHaveLength(0);
    setup("admin", { deleteUserError: true });
    expect((await post(deleteData, { scope: "account", studentId: OTHER, confirm: "حذف" })).status).toBe(409);
    expect(S.audits).toHaveLength(0);
  });
});

describe("PATCH /api/privacy/preferences", () => {
  it("updates only the caller's own profile flag", async () => {
    const t = setup("student");
    expect((await post(prefs, { allowTranscriptRetention: false }, "PATCH")).status).toBe(200);
    const upd = t.server.calls.find((c) => c.table === "profiles" && c.action === "update")!;
    expect(upd.values).toEqual({ allow_transcript_retention: false });
    expect(upd.filters).toEqual({ id: ME });
    expect((await post(prefs, { allowTranscriptRetention: "no" }, "PATCH")).status).toBe(400);
  });
});

describe("GET /api/cron/purge", () => {
  const env = { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "s".repeat(30), CRON_SECRET: "c".repeat(20), TRANSCRIPT_RETENTION_DAYS: "30" };
  beforeEach(() => { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); });
  afterEach(() => vi.unstubAllEnvs());
  it("refuses to run without CRON_SECRET configured, with a wrong secret, or with none", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await purge(new Request("http://x"))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", env.CRON_SECRET);
    expect((await purge(new Request("http://x"))).status).toBe(401);
    expect((await purge(new Request("http://x", { headers: { authorization: "Bearer wrong-secret-value!!" } }))).status).toBe(401);
  });
});
