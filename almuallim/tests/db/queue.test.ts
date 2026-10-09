import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./helpers";

let db: Client;
let admin: string;
const mkVersion = async (sha: string) => {
  const book = randomUUID();
  const v = randomUUID();
  await db.query("insert into books (id,title,year_min,year_max,license_attestation,license_attested_by,created_by) values ($1,'t',7,7,'Licensed for school use',$2,$2)", [book, admin]);
  await db.query("insert into book_versions (id,book_id,storage_path,file_sha256,uploaded_by) values ($1,$2,'x.pdf',$3,$4)", [v, book, sha.padEnd(64, "0"), admin]);
  return v;
};

beforeAll(async () => {
  db = await connect();
  admin = randomUUID();
  await db.query("insert into auth.users (id) values ($1)", [admin]);
  await db.query("update profiles set role='admin' where id=$1", [admin]);
});
afterAll(async () => { await db.end(); });
beforeEach(async () => { await db.query("delete from ingestion_jobs"); });

describe("ingestion queue (real PostgreSQL)", () => {
  it("enqueue is idempotent for the same upload and marks the version processing", async () => {
    const v = await mkVersion("a1");
    const j1 = (await db.query("select * from enqueue_ingestion($1,$2)", [v, admin])).rows[0];
    const j2 = (await db.query("select * from enqueue_ingestion($1,$2)", [v, admin])).rows[0];
    expect(j2.id).toBe(j1.id);
    expect((await db.query("select count(*)::int c from ingestion_jobs where book_version_id=$1", [v])).rows[0].c).toBe(1);
    expect((await db.query("select status from book_versions where id=$1", [v])).rows[0].status).toBe("processing");
    const forced = (await db.query("select * from enqueue_ingestion($1,$2,true)", [v, admin])).rows[0];
    expect(forced.id).not.toBe(j1.id);
  });

  it("concurrent workers never claim the same job (SKIP LOCKED)", async () => {
    const vs = await Promise.all(["b1", "b2", "b3"].map(mkVersion));
    for (const v of vs) await db.query("select enqueue_ingestion($1,$2)", [v, admin]);
    const clients = await Promise.all([connect(), connect(), connect(), connect()]);
    const claimed = await Promise.all(clients.map((c, i) => c.query("select * from claim_ingestion_job($1, 60)", [`w${i}`])));
    await Promise.all(clients.map((c) => c.end()));
    const ids = claimed.map((r) => r.rows[0]?.id).filter(Boolean);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("empty queue returns a null row", async () => {
    const r = await db.query("select * from claim_ingestion_job('w', 60)");
    expect(r.rows[0].id).toBeNull();
  });

  it("an expired lease is reclaimed by another worker; heartbeat from the old worker is rejected", async () => {
    const v = await mkVersion("c1");
    await db.query("select enqueue_ingestion($1,$2)", [v, admin]);
    const a = (await db.query("select * from claim_ingestion_job('wA', 60)")).rows[0];
    expect((await db.query("select * from claim_ingestion_job('wB', 60)")).rows[0].id).toBeNull();
    await db.query("update ingestion_jobs set lease_expires_at = now() - interval '1 second' where id=$1", [a.id]);
    const b = (await db.query("select * from claim_ingestion_job('wB', 60)")).rows[0];
    expect(b.id).toBe(a.id);
    expect(b.attempts).toBe(2);
    expect((await db.query("select heartbeat_ingestion_job($1,'wA',60,'extract','{}') ok", [a.id])).rows[0].ok).toBe(false);
    expect((await db.query("select heartbeat_ingestion_job($1,'wB',60,'extract','{\"pages_done\":3}') ok", [a.id])).rows[0].ok).toBe(true);
    const row = (await db.query("select stage, progress from ingestion_jobs where id=$1", [a.id])).rows[0];
    expect(row.stage).toBe("extract");
    expect(row.progress.pages_done).toBe(3);
  });

  it("retryable failure backs off exponentially; exhausting attempts fails the version", async () => {
    const v = await mkVersion("d1");
    await db.query("select enqueue_ingestion($1,$2)", [v, admin]);
    await db.query("update ingestion_jobs set max_attempts=2 where book_version_id=$1", [v]);
    const j = (await db.query("select * from claim_ingestion_job('w', 60)")).rows[0];
    expect((await db.query("select fail_ingestion_job($1,'w','boom',true) s", [j.id])).rows[0].s).toBe("queued");
    const queued = (await db.query("select status, run_after > now() as delayed from ingestion_jobs where id=$1", [j.id])).rows[0];
    expect(queued).toEqual({ status: "queued", delayed: true });
    expect((await db.query("select * from claim_ingestion_job('w', 60)")).rows[0].id).toBeNull(); // not due yet
    await db.query("update ingestion_jobs set run_after=now() where id=$1", [j.id]);
    const j2 = (await db.query("select * from claim_ingestion_job('w', 60)")).rows[0];
    expect(j2.attempts).toBe(2);
    expect((await db.query("select fail_ingestion_job($1,'w','boom again',true) s", [j.id])).rows[0].s).toBe("failed");
    expect((await db.query("select status, error from book_versions where id=$1", [v])).rows[0]).toEqual({ status: "failed", error: "boom again" });
  });

  it("non-retryable failure is terminal immediately; success marks the version ready", async () => {
    const v1 = await mkVersion("e1");
    await db.query("select enqueue_ingestion($1,$2)", [v1, admin]);
    const j1 = (await db.query("select * from claim_ingestion_job('w', 60)")).rows[0];
    expect((await db.query("select fail_ingestion_job($1,'w','corrupt pdf',false) s", [j1.id])).rows[0].s).toBe("failed");

    const v2 = await mkVersion("e2");
    await db.query("select enqueue_ingestion($1,$2)", [v2, admin]);
    const j2 = (await db.query("select * from claim_ingestion_job('w', 60)")).rows[0];
    expect((await db.query("select complete_ingestion_job($1,'wrong') ok", [j2.id])).rows[0].ok).toBe(false);
    expect((await db.query("select complete_ingestion_job($1,'w') ok", [j2.id])).rows[0].ok).toBe(true);
    const bv = (await db.query("select status, ready_at is not null as ready from book_versions where id=$1", [v2])).rows[0];
    expect(bv).toEqual({ status: "ready", ready: true });
  });

  it("jobs that die after max attempts are reaped to failed", async () => {
    const v = await mkVersion("f1");
    await db.query("select enqueue_ingestion($1,$2)", [v, admin]);
    const j = (await db.query("select * from claim_ingestion_job('w', 60)")).rows[0];
    await db.query("update ingestion_jobs set max_attempts=1, lease_expires_at=now()-interval '1 second' where id=$1", [j.id]);
    await db.query("select * from claim_ingestion_job('w2', 60)");
    expect((await db.query("select status from ingestion_jobs where id=$1", [j.id])).rows[0].status).toBe("failed");
    expect((await db.query("select status from book_versions where id=$1", [v])).rows[0].status).toBe("failed");
  });
});
