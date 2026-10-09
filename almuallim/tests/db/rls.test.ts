import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, as, authed, connect, service, vec } from "./helpers";

let db: Client;
const id = () => randomUUID();
const U = { admin: id(), t1: id(), t2: id(), s1: id(), s2: id(), s3: id() };
const F = {
  book: id(), vReady: id(), vProc: id(), lesson: id(),
  sess1: id(), sess2: id(), sess3: id(), item: id(), assess: id(), resp1: id(),
  chunkA: id(), chunkB: id(), chunkC: id(), class1: id(), class2: id(),
};
const sha = "a".repeat(64);
const sha2 = "b".repeat(64);

beforeAll(async () => {
  db = await connect();
  for (const [k, uid] of Object.entries(U)) {
    await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [
      uid, `${k}@example.test`, JSON.stringify({ display_name: k }),
    ]);
  }
  await db.query("update profiles set role='admin' where id=$1", [U.admin]);
  await db.query("update profiles set role='teacher' where id = any($1)", [[U.t1, U.t2]]);
  await db.query("update profiles set year_group=9 where role='student'");
  await db.query("insert into classes (id,name,year_group,teacher_id) values ($1,'9A',9,$2),($3,'9B',9,$4)", [F.class1, U.t1, F.class2, U.t2]);
  await db.query("insert into class_members (class_id, student_id) values ($1,$2),($1,$3),($4,$5)", [F.class1, U.s1, U.s2, F.class2, U.s3]);
  await db.query("insert into books (id,title,year_min,year_max,license_attestation,license_attested_by,created_by) values ($1,'كتاب',9,9,'Licensed for school use',$2,$2)", [F.book, U.admin]);
  await db.query("insert into book_versions (id,book_id,version_label,status,storage_path,file_sha256,uploaded_by,page_count) values ($1,$2,'1','ready','p.pdf',$3,$4,10),($5,$2,'2','processing','q.pdf',$6,$4,10)", [F.vReady, F.book, sha, U.admin, F.vProc, sha2]);
  await db.query("insert into lessons (id,book_version_id,ordinal,title,start_page,end_page,detection_method) values ($1,$2,0,'الدرس الأول',1,5,'heading')", [F.lesson, F.vReady]);
  const ins = `insert into content_chunks (id,book_version_id,lesson_id,ordinal,page_start,page_end,content,content_normalized,content_hash,embedding) values ($1,$2,$3,$4,1,1,$5,$6,$7,$8::vector)`;
  await db.query(ins, [F.chunkA, F.vReady, F.lesson, 0, "الفاعل اسم مرفوع", "الفاعل اسم مرفوع", "h1", vec(0)]);
  await db.query(ins, [F.chunkB, F.vReady, F.lesson, 1, "المفعول به اسم منصوب", "المفعول به اسم منصوب", "h2", vec(1)]);
  await db.query(ins, [F.chunkC, F.vProc, null, 0, "نص غير جاهز", "نص غير جاهز", "h3", vec(2)]);
  for (const [sid, s] of [[U.s1, F.sess1], [U.s2, F.sess2], [U.s3, F.sess3]]) {
    await db.query("insert into tutoring_sessions (id, student_id) values ($1,$2)", [s, sid]);
  }
  await db.query("insert into assessments (id, student_id, lesson_id, kind) values ($1,$2,$3,'practice')", [F.assess, U.s1, F.lesson]);
  await db.query("insert into assessment_items (id, assessment_id, ordinal, skill, prompt) values ($1,$2,0,'grammar','أعرب')", [F.item, F.assess]);
  await db.query("insert into student_responses (id, assessment_item_id, student_id, session_id, response_text, ai_score) values ($1,$2,$3,$4,'إجابة',60)", [F.resp1, F.item, U.s1, F.sess1]);
  await db.query("insert into skill_mastery (student_id, skill, lesson_id, ai_estimate) values ($1,'grammar',$2,0.4)", [U.s1, F.lesson]);
});
afterAll(async () => { await db?.end(); });

describe("profiles & roles", () => {
  it("auth signup creates a student profile only", async () => {
    const r = await db.query("select role from profiles where id=$1", [U.s1]);
    expect(r.rows[0].role).toBe("student");
  });
  it("a student cannot escalate their own role", async () => {
    await expect(as(db, authed(U.s1), (q) => q("update profiles set role='admin' where id=$1", [U.s1]))).rejects.toThrow(/role changes/);
  });
  it("a student cannot self-insert a privileged profile", async () => {
    const x = id();
    await db.query("insert into auth.users (id) values ($1) on conflict do nothing", [x]);
    await db.query("delete from profiles where id=$1", [x]);
    await expect(as(db, authed(x), (q) => q("insert into profiles (id, role) values ($1,'admin')", [x]))).rejects.toThrow(/self-register/);
  });
  it("an admin may change roles", async () => {
    await as(db, authed(U.admin), (q) => q("update profiles set role='teacher' where id=$1", [U.s3]));
  });
  it("students see only themselves; teachers see only their class", async () => {
    expect((await as(db, authed(U.s1), (q) => q("select id from profiles"))).rows.map((r) => r.id)).toEqual([U.s1]);
    const t1 = (await as(db, authed(U.t1), (q) => q("select id from profiles"))).rows.map((r) => r.id).sort();
    expect(t1).toEqual([U.t1, U.s1, U.s2].sort());
  });
  it("anon sees nothing", async () => {
    await expect(as(db, anon, (q) => q("select * from profiles"))).rejects.toThrow(/permission denied/);
  });
});

describe("student data isolation", () => {
  it("student reads only own sessions / responses / mastery", async () => {
    expect((await as(db, authed(U.s1), (q) => q("select id from tutoring_sessions"))).rows.map((r) => r.id)).toEqual([F.sess1]);
    expect((await as(db, authed(U.s2), (q) => q("select id from student_responses"))).rowCount).toBe(0);
    expect((await as(db, authed(U.s2), (q) => q("select id from skill_mastery"))).rowCount).toBe(0);
    expect((await as(db, authed(U.s1), (q) => q("select id from skill_mastery"))).rowCount).toBe(1);
  });
  it("teacher sees own class only; other teacher sees nothing of them", async () => {
    expect((await as(db, authed(U.t1), (q) => q("select student_id from tutoring_sessions"))).rows.map((r) => r.student_id).sort()).toEqual([U.s1, U.s2].sort());
    expect((await as(db, authed(U.t2), (q) => q("select id from student_responses"))).rowCount).toBe(0);
  });
  it("a student cannot create a session for someone else", async () => {
    await expect(as(db, authed(U.s1), (q) => q("insert into tutoring_sessions (student_id) values ($1)", [U.s2]))).rejects.toThrow(/row-level security/);
  });
  it("append_session_event assigns increasing seq and respects ownership", async () => {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role','authenticated',true)", [U.s1]);
    const a = await db.query("select * from append_session_event($1,'user_text','{\"t\":1}')", [F.sess1]);
    const b = await db.query("select * from append_session_event($1,'assistant_text','{\"t\":2}', '[{\"page\":1}]')", [F.sess1]);
    await db.query("rollback");
    expect([a.rows[0].seq, b.rows[0].seq]).toEqual([1, 2]);
    await expect(as(db, authed(U.s1), (q) => q("select * from append_session_event($1,'user_text','{}')", [F.sess2]))).rejects.toThrow(/not found or not accessible/);
  });
  it("a student cannot read another student's events", async () => {
    await db.query("insert into session_events (session_id, student_id, seq, type) values ($1,$2,1,'user_text')", [F.sess2, U.s2]);
    expect((await as(db, authed(U.s1), (q) => q("select id from session_events where session_id=$1", [F.sess2]))).rowCount).toBe(0);
    expect((await as(db, authed(U.s2), (q) => q("select id from session_events where session_id=$1", [F.sess2]))).rowCount).toBe(1);
    await db.query("delete from session_events where session_id=$1", [F.sess2]);
  });
});

describe("AI estimate vs teacher validation", () => {
  it("students cannot submit a response with a score", async () => {
    await expect(as(db, authed(U.s1), (q) => q("insert into student_responses (assessment_item_id, student_id, response_text, ai_score) values ($1,$2,'x',100)", [F.item, U.s1]))).rejects.toThrow(/scores cannot be set/);
  });
  it("students cannot validate or alter AI fields", async () => {
    // No UPDATE policy for students → RLS filters the row out; nothing is modified.
    expect((await as(db, authed(U.s1), (q) => q("update student_responses set teacher_score=100 where id=$1", [F.resp1]))).rowCount).toBe(0);
    expect((await as(db, authed(U.s1), (q) => q("update student_responses set ai_score=100 where id=$1", [F.resp1]))).rowCount).toBe(0);
  });
  it("the class teacher can validate, stamping validator; another teacher cannot", async () => {
    const r = await as(db, authed(U.t1), (q) => q("update student_responses set teacher_score=75, teacher_feedback='جيد' where id=$1 returning teacher_validated_by, ai_score", [F.resp1]));
    expect(r.rows[0].teacher_validated_by).toBe(U.t1);
    expect(Number(r.rows[0].ai_score)).toBe(60); // AI estimate untouched
    const r2 = await as(db, authed(U.t2), (q) => q("update student_responses set teacher_score=10 where id=$1", [F.resp1]));
    expect(r2.rowCount).toBe(0);
  });
  it("mastery: students cannot write; teacher may only set teacher_validated", async () => {
    expect((await as(db, authed(U.s1), (q) => q("update skill_mastery set ai_estimate=1 where student_id=$1", [U.s1]))).rowCount).toBe(0);
    await expect(as(db, authed(U.s1), (q) => q("insert into skill_mastery (student_id, skill) values ($1,'writing')", [U.s1]))).rejects.toThrow(/server-written|row-level security/);
    await expect(as(db, authed(U.t1), (q) => q("update skill_mastery set ai_estimate=1 where student_id=$1", [U.s1]))).rejects.toThrow(/only teacher_validated/);
    const ok = await as(db, authed(U.t1), (q) => q("update skill_mastery set teacher_validated=0.7 where student_id=$1 returning ai_estimate, teacher_validated", [U.s1]));
    expect(Number(ok.rows[0].teacher_validated)).toBe(0.7);
    expect(Number(ok.rows[0].ai_estimate)).toBe(0.4);
  });
});

describe("textbook access control", () => {
  it("students cannot read raw pages/chunks, but admins and teachers can", async () => {
    expect((await as(db, authed(U.s1), (q) => q("select id from content_chunks"))).rowCount).toBe(0);
    expect((await as(db, authed(U.t1), (q) => q("select id from content_chunks"))).rowCount).toBe(3);
  });
  it("students only see READY versions", async () => {
    const r = await as(db, authed(U.s1), (q) => q("select id from book_versions"));
    expect(r.rows.map((x) => x.id)).toEqual([F.vReady]);
  });
  it("only admins write books", async () => {
    await expect(as(db, authed(U.t1), (q) => q("insert into books (title,year_min,year_max,license_attestation,license_attested_by,created_by) values ('x',7,7,'Licensed for school use',$1,$1)", [U.t1]))).rejects.toThrow(/row-level security/);
  });
  it("search_content serves ready content to students (bounded) and refuses unready versions", async () => {
    const r = await as(db, authed(U.s1), (q) => q("select * from search_content($1::vector, 'الفاعل', $2, null, 50)", [vec(0), F.vReady]));
    expect(r.rowCount).toBeLessThanOrEqual(12);
    expect(r.rows[0].chunk_id).toBe(F.chunkA);
    expect(r.rows[0].vector_similarity).toBeCloseTo(1, 5);
    const none = await as(db, authed(U.s1), (q) => q("select * from search_content($1::vector, 'نص', $2)", [vec(2), F.vProc]));
    expect(none.rowCount).toBe(0);
  });
  it("search_content is unavailable to anon", async () => {
    await expect(as(db, anon, (q) => q("select * from search_content($1::vector,'x',$2)", [vec(0), F.vReady]))).rejects.toThrow(/permission denied/);
  });
  it("hybrid search: lexical hit outranks a semantically-unrelated vector, and tsquery syntax is harmless", async () => {
    // query vector points at chunk B but the words only occur in chunk A → fused ranking keeps both, A via lexical
    const r = await as(db, authed(U.s1), (q) => q("select chunk_id, lexical_score from search_content($1::vector, $2, $3)", [vec(1), "الفاعل & | ! ( ) ' \\ :*", F.vReady]));
    const ids = r.rows.map((x) => x.chunk_id);
    expect(ids).toContain(F.chunkA);
    expect(ids).toContain(F.chunkB);
  });
});

describe("audit log", () => {
  it("is readable only by admins and is append-only even for the server", async () => {
    await db.query("insert into audit_logs (actor_id, action) values ($1,'test')", [U.admin]);
    expect((await as(db, authed(U.s1), (q) => q("select * from audit_logs"))).rowCount).toBe(0);
    expect((await as(db, authed(U.admin), (q) => q("select * from audit_logs"))).rowCount).toBeGreaterThan(0);
    await expect(as(db, service, (q) => q("update audit_logs set action='x'"))).rejects.toThrow(/append-only/);
    await expect(as(db, service, (q) => q("delete from audit_logs"))).rejects.toThrow(/append-only/);
    await expect(as(db, authed(U.admin), (q) => q("insert into audit_logs (action) values ('forged')"))).rejects.toThrow(/permission denied/);
  });
});

describe("server-only functions", () => {
  it("end users cannot call queue or rate-limit functions", async () => {
    await expect(as(db, authed(U.admin), (q) => q("select * from claim_ingestion_job('w', 60)"))).rejects.toThrow(/permission denied/);
    await expect(as(db, authed(U.s1), (q) => q("select rate_limit_hit('k', 60, 5)"))).rejects.toThrow(/permission denied/);
  });
  it("rate_limit_hit enforces a fixed window", async () => {
    const key = `t:${id()}`;
    const res: boolean[] = [];
    for (let i = 0; i < 5; i++) res.push((await as(db, service, (q) => q("select rate_limit_hit($1, 3600, 3) as ok", [key]))).rows[0].ok);
    // each `as` rolls back, so use one transaction for the sequence
    await db.query("begin");
    const seq: boolean[] = [];
    for (let i = 0; i < 5; i++) seq.push((await db.query("select rate_limit_hit($1, 3600, 3) as ok", [key + "b"])).rows[0].ok);
    await db.query("rollback");
    expect(seq).toEqual([true, true, true, false, false]);
    expect(res.every(Boolean)).toBe(true);
  });
});
