import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "../helpers/fake-supabase";

const state = vi.hoisted(() => ({ server: null as unknown, admin: null as unknown, audits: [] as unknown[] }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => state.server }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdmin: () => state.admin }));
vi.mock("@/lib/audit", () => ({ audit: async (_c: unknown, e: unknown) => void state.audits.push(e) }));

import { POST as createBook } from "@/app/api/admin/books/route";
import { POST as ingest } from "@/app/api/admin/versions/[id]/ingest/route";

const validBody = {
  title: "لغتي العربية", yearMin: 9, yearMax: 9, licenseConfirmed: true,
  licenseAttestation: "Licensed for school use under contract #123", fileSha256: "a".repeat(64), fileSize: 1000,
};
const req = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

function setUser(role: string | null) {
  const created: Record<string, unknown>[] = [];
  const db = fakeDb({
    user: role ? { id: "u1" } : null,
    handler: ({ table, action, values }) => {
      if (table === "profiles") return { data: { id: "u1", role, display_name: "x", year_group: null, allow_transcript_retention: true } };
      if (table === "books" && action === "insert") return { data: { id: "book-1" } };
      if (table === "book_versions" && action === "insert") return (created.push(values as never), {});
      if (table === "book_versions" && action === "select") return { data: { id: "11111111-1111-4111-8111-111111111111", storage_path: "books/b/v.pdf", status: "uploaded" } };
      return {};
    },
  });
  state.server = db.client;
  return { db, created };
}
function setAdmin(opts: { fileExists?: boolean } = {}) {
  const enqueue = vi.fn();
  state.admin = {
    storage: {
      from: () => ({
        createSignedUploadUrl: async (p: string) => ({ data: { path: p, token: "tok", signedUrl: "https://s/x" }, error: null }),
        list: async () => ({ data: opts.fileExists === false ? [] : [{ name: "v.pdf" }], error: null }),
      }),
    },
    rpc: async (name: string, args: unknown) => (enqueue(name, args), { data: { id: "job-1", status: "queued" }, error: null }),
  };
  return enqueue;
}

beforeEach(() => { state.audits.length = 0; });

describe("POST /api/admin/books", () => {
  it("401 when not signed in", async () => {
    setUser(null); setAdmin();
    expect((await createBook(req(validBody))).status).toBe(401);
  });
  it("403 for students and teachers", async () => {
    setAdmin();
    for (const role of ["student", "teacher"]) {
      setUser(role);
      expect((await createBook(req(validBody))).status).toBe(403);
    }
  });
  it("400 without the licence confirmation, with a bad hash, or with inverted years", async () => {
    setUser("admin"); setAdmin();
    expect((await createBook(req({ ...validBody, licenseConfirmed: false }))).status).toBe(400);
    expect((await createBook(req({ ...validBody, fileSha256: "xyz" }))).status).toBe(400);
    expect((await createBook(req({ ...validBody, yearMin: 12, yearMax: 8 }))).status).toBe(400);
    expect((await createBook(req({ ...validBody, fileSize: 600 * 1024 * 1024 }))).status).toBe(400);
  });
  it("creates book + version, returns a signed upload target and audits the licence attestation", async () => {
    const { db, created } = setUser("admin"); setAdmin();
    const res = await createBook(req(validBody));
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.upload.token).toBe("tok");
    expect(j.storagePath).toMatch(/^books\/book-1\/[0-9a-f-]{36}\.pdf$/);
    expect(created[0]).toMatchObject({ book_id: "book-1", status: "uploaded", file_sha256: "a".repeat(64) });
    expect(db.calls.find((c) => c.table === "books" && c.action === "insert")!.values).toMatchObject({ license_attested_by: "u1" });
    expect(state.audits[0]).toMatchObject({ action: "book.create", actorId: "u1" });
  });
});

describe("POST /api/admin/versions/[id]/ingest", () => {
  const ctx = { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) };
  it("is admin-only", async () => {
    setUser("student"); setAdmin();
    expect((await ingest(req({}), ctx)).status).toBe(403);
  });
  it("rejects malformed ids", async () => {
    setUser("admin"); setAdmin();
    expect((await ingest(req({}), { params: Promise.resolve({ id: "nope" }) })).status).toBe(400);
  });
  it("refuses to queue work when the PDF is not in storage yet", async () => {
    setUser("admin"); const enqueue = setAdmin({ fileExists: false });
    expect((await ingest(req({}), ctx)).status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("enqueues idempotently and audits", async () => {
    setUser("admin"); const enqueue = setAdmin();
    const res = await ingest(req({ force: true }), ctx);
    expect(res.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith("enqueue_ingestion", { p_version: "11111111-1111-4111-8111-111111111111", p_requested_by: "u1", p_force: true });
    expect(state.audits[0]).toMatchObject({ action: "ingestion.enqueue" });
  });
});
