import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@/lib/logger";
import { createPgIngestionStore } from "@/lib/ingestion/pg-store";
import { processJob } from "@/lib/ingestion/process-job";
import { createQueueClient } from "@/lib/ingestion/queue";
import type { IngestionPorts } from "@/lib/ingestion/pipeline";
import { FakeEmbeddings, FixturePdfSource, fixtureSha, makeFakeEmbedding } from "../helpers/fakes";
import { as, connect, service } from "./helpers";
import { toVectorLiteral } from "@/lib/providers/embeddings";

let db: Client;
let admin: string;
const log = createLogger({}, (l) => { if (process.env.DEBUG_INGEST) console.log(l); });

async function newVersion(file: string, sha = fixtureSha(file)) {
  const book = randomUUID();
  const v = randomUUID();
  await db.query("insert into books (id,title,year_min,year_max,license_attestation,license_attested_by,created_by) values ($1,'لغتي العربية',9,9,'Licensed for school use',$2,$2)", [book, admin]);
  await db.query("insert into book_versions (id,book_id,storage_path,file_sha256,uploaded_by) values ($1,$2,$3,$4,$5)", [v, book, `${v}.pdf`, sha, admin]);
  return { v, path: `${v}.pdf` };
}
const mkPorts = (files: Record<string, string>, emb = new FakeEmbeddings()): IngestionPorts & { emb: FakeEmbeddings } => ({
  store: createPgIngestionStore(db), pdf: new FixturePdfSource(files), embeddings: emb, log, emb,
});
async function enqueueAndRun(v: string, ports: IngestionPorts, force = false, worker = "w1") {
  await db.query("select enqueue_ingestion($1,$2,$3)", [v, admin, force]);
  const queue = createQueueClient(db, worker, 60);
  const job = await queue.claim();
  expect(job).not.toBeNull();
  return { outcome: await processJob(job!, queue, ports, log), job: job!, queue };
}

beforeAll(async () => {
  db = await connect();
  admin = randomUUID();
  await db.query("insert into auth.users (id) values ($1)", [admin]);
  await db.query("update profiles set role='admin' where id=$1", [admin]);
});
afterAll(async () => { await db.end(); });

describe("ingestion pipeline on real PostgreSQL + the real PDF fixture", () => {
  it("ingests pages, lessons, chunks and embeddings, and marks the version ready", async () => {
    const { v, path } = await newVersion("sample-textbook.pdf");
    const ports = mkPorts({ [path]: "sample-textbook.pdf" });
    const { outcome } = await enqueueAndRun(v, ports);
    expect(outcome).toBe("succeeded");

    expect((await db.query("select status, page_count from book_versions where id=$1", [v])).rows[0]).toEqual({ status: "ready", page_count: 6 });
    const pages = (await db.query("select page_number, has_text, printed_label, embedding is not null as emb from book_pages where book_version_id=$1 order by 1", [v])).rows;
    expect(pages).toHaveLength(6);
    expect(pages.every((p) => p.has_text && p.emb)).toBe(true);

    const lessons = (await db.query("select ordinal, title, start_page, end_page, detection_method, learning_objectives from lessons where book_version_id=$1 order by ordinal", [v])).rows;
    expect(lessons.map((l) => [l.start_page, l.end_page, l.detection_method])).toEqual([[2, 3, "outline"], [4, 5, "outline"], [6, 6, "outline"]]);
    expect(lessons.every((l) => l.learning_objectives.length === 0)).toBe(true); // never invented

    const chunks = (await db.query("select lesson_id, page_start, page_end, embedding is not null as emb from content_chunks where book_version_id=$1", [v])).rows;
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every((c) => c.emb)).toBe(true);
    expect(chunks.filter((c) => c.lesson_id).length).toBeGreaterThanOrEqual(3);

    const job = (await db.query("select status, stage, progress from ingestion_jobs where book_version_id=$1", [v])).rows[0];
    expect(job.status).toBe("succeeded");
    expect(job.progress.summary.lessons).toBe(3);
    const usage = (await db.query("select kind from usage_ledger where user_id=$1", [admin])).rows;
    expect(usage.some((u) => u.kind === "embedding_tokens")).toBe(true);
  });

  it("retrieves the right passage with a page citation (hybrid search)", async () => {
    const { v, path } = await newVersion("sample-textbook.pdf");
    await enqueueAndRun(v, mkPorts({ [path]: "sample-textbook.pdf" }));
    const q = "ما هو الفاعل وما علامة رفعه";
    const r = await as(db, service, (qq) => qq(
      "select page_start, page_end, lesson_title, content, vector_similarity from search_content($1::vector, $2, $3, null, 3)",
      [toVectorLiteral(makeFakeEmbedding(q)), q, v],
    ));
    expect(r.rows[0].lesson_title).toContain("الفاعل");
    expect(r.rows[0].page_start).toBeGreaterThanOrEqual(2);
    expect(r.rows[0].page_end).toBeLessThanOrEqual(3);
    expect(r.rows[0].content).toContain("الفاعل اسم مرفوع");

    const q2 = "المفعول به منصوب";
    const r2 = await as(db, service, (qq) => qq("select lesson_title from search_content($1::vector, $2, $3, null, 1)", [toVectorLiteral(makeFakeEmbedding(q2)), q2, v]));
    expect(r2.rows[0].lesson_title).toContain("المفعول به");
  });

  it("is idempotent: a forced re-run keeps lesson ids and re-embeds nothing", async () => {
    const { v, path } = await newVersion("sample-textbook.pdf");
    const emb = new FakeEmbeddings();
    const ports = mkPorts({ [path]: "sample-textbook.pdf" }, emb);
    await enqueueAndRun(v, ports);
    const snapshot = async () => ({
      lessons: (await db.query("select id, title from lessons where book_version_id=$1 order by ordinal", [v])).rows,
      chunks: (await db.query("select ordinal, content_hash from content_chunks where book_version_id=$1 order by ordinal", [v])).rows,
      counts: (await db.query("select (select count(*) from book_pages where book_version_id=$1)::int p, (select count(*) from content_chunks where book_version_id=$1)::int c", [v])).rows[0],
    });
    const before = await snapshot();
    const embeddedBefore = emb.textsEmbedded;
    const { outcome } = await enqueueAndRun(v, ports, true);
    expect(outcome).toBe("succeeded");
    expect(await snapshot()).toEqual(before);
    expect(emb.textsEmbedded).toBe(embeddedBefore);
  });

  it("resumes after a provider outage: retry state, then only the missing embeddings are computed", async () => {
    const { v, path } = await newVersion("sample-textbook.pdf");
    const emb = new FakeEmbeddings();
    emb.failOnCall = 2; // chunk batch succeeds, page batch fails
    const ports = mkPorts({ [path]: "sample-textbook.pdf" }, emb);
    const first = await enqueueAndRun(v, ports);
    expect(first.outcome).toBe("retry");
    expect((await db.query("select status from book_versions where id=$1", [v])).rows[0].status).toBe("processing");
    expect((await db.query("select count(*)::int c from content_chunks where book_version_id=$1 and embedding is null", [v])).rows[0].c).toBe(0);
    expect((await db.query("select count(*)::int c from book_pages where book_version_id=$1 and embedding is null", [v])).rows[0].c).toBe(6);

    await db.query("update ingestion_jobs set run_after = now() where id=$1", [first.job.id]);
    const before = emb.textsEmbedded;
    const queue = createQueueClient(db, "w2", 60);
    const job2 = (await queue.claim())!;
    expect(job2.attempts).toBe(2);
    expect(await processJob(job2, queue, ports, log)).toBe("succeeded");
    expect(emb.textsEmbedded - before).toBe(6); // only the 6 pages; chunks were not re-embedded
    expect((await db.query("select status from book_versions where id=$1", [v])).rows[0].status).toBe("ready");
  });

  it("fails non-retryably on a checksum mismatch", async () => {
    const { v, path } = await newVersion("sample-textbook.pdf", "f".repeat(64));
    const { outcome } = await enqueueAndRun(v, mkPorts({ [path]: "sample-textbook.pdf" }));
    expect(outcome).toBe("failed");
    const row = (await db.query("select status, error from book_versions where id=$1", [v])).rows[0];
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/checksum/);
  });

  it("fails non-retryably with actionable advice for a scanned PDF without a text layer", async () => {
    const { v, path } = await newVersion("no-text.pdf");
    const { outcome } = await enqueueAndRun(v, mkPorts({ [path]: "no-text.pdf" }));
    expect(outcome).toBe("failed");
    expect((await db.query("select error from book_versions where id=$1", [v])).rows[0].error).toMatch(/OCR/);
  });

  it("abandons the job (without failing it) when the lease is lost mid-run", async () => {
    const { v, path } = await newVersion("sample-textbook.pdf");
    await db.query("select enqueue_ingestion($1,$2)", [v, admin]);
    const queue = createQueueClient(db, "slow", 60);
    const job = (await queue.claim())!;
    // another worker steals the lease
    await db.query("update ingestion_jobs set locked_by='thief' where id=$1", [job.id]);
    const outcome = await processJob(job, queue, mkPorts({ [path]: "sample-textbook.pdf" }), log);
    expect(outcome).toBe("lease_lost");
    expect((await db.query("select status, locked_by from ingestion_jobs where id=$1", [job.id])).rows[0]).toEqual({ status: "running", locked_by: "thief" });
  });
});

describe("retrieval over ingested content (real PostgreSQL)", () => {
  it("lexical query expansion finds 'الفاعل' from a bare 'فاعل' even when the vector says nothing", async () => {
    const { lexicalQueryText } = await import("@/lib/retrieval/lexical");
    const { v, path } = await newVersion("sample-textbook.pdf");
    await enqueueAndRun(v, mkPorts({ [path]: "sample-textbook.pdf" }));
    const unrelated = toVectorLiteral(makeFakeEmbedding("zzz qqq www"));
    const r = await as(db, service, (q) => q("select lesson_title, lexical_score from search_content($1::vector, $2, $3, null, 3)", [unrelated, lexicalQueryText("فاعل"), v]));
    expect(r.rows[0].lesson_title).toContain("الفاعل");
    expect(Number(r.rows[0].lexical_score)).toBeGreaterThan(0);
  });

  it("get_page_text: students read pages of READY versions only; anon cannot", async () => {
    const { v, path } = await newVersion("sample-textbook.pdf");
    const student = randomUUID();
    await db.query("insert into auth.users (id) values ($1)", [student]);
    // not ready yet → nothing
    const before = await as(db, { sub: student, role: "authenticated" }, (q) => q("select * from get_page_text($1, 2)", [v]));
    expect(before.rowCount).toBe(0);
    await enqueueAndRun(v, mkPorts({ [path]: "sample-textbook.pdf" }));
    const after = await as(db, { sub: student, role: "authenticated" }, (q) => q("select * from get_page_text($1, 2)", [v]));
    expect(after.rowCount).toBe(1);
    expect(after.rows[0].text).toContain("الفاعل اسم مرفوع");
    expect(after.rows[0].lesson_title).toContain("الفاعل");
    await expect(as(db, { sub: null, role: "anon" }, (q) => q("select * from get_page_text($1, 2)", [v]))).rejects.toThrow(/permission denied/);
  });
});
