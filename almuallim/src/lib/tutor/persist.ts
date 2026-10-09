import type { SupabaseClient } from "@supabase/supabase-js";
import type { VerifiedAnswer } from "./answer";
import { updateMastery, type MasteryState } from "./mastery";
import type { Evidence } from "./tool-core";
import type { Level, Skill, TutorContext } from "./types";

interface SessionRow {
  id: string; student_id: string; mode: TutorContext["mode"]; level: Level; book_version_id: string | null;
  lesson_id: string | null; current_page: number | null; objective: string | null; status: string; channel: string;
}

/** Load the session and everything the tutor needs, under the CALLER's RLS (so foreign sessions are invisible). */
export async function loadTutorContext(
  db: SupabaseClient,
  sessionId: string,
  profile: { id: string; year_group: number | null },
): Promise<{ ctx: TutorContext; session: SessionRow } | null> {
  const { data: session } = await db
    .from("tutoring_sessions")
    .select("id, student_id, mode, level, book_version_id, lesson_id, current_page, objective, status, channel")
    .eq("id", sessionId)
    .single();
  if (!session || session.student_id !== profile.id) return null;
  const s = session as SessionRow;

  let lessonTitle: string | null = null;
  if (s.lesson_id) {
    const { data } = await db.from("lessons").select("title").eq("id", s.lesson_id).single();
    lessonTitle = (data as { title: string } | null)?.title ?? null;
  }
  const mastery: TutorContext["mastery"] = {};
  const { data: rows } = await db.from("skill_mastery").select("skill, ai_estimate, evidence_count").eq("student_id", profile.id);
  for (const r of (rows ?? []) as { skill: Skill; ai_estimate: number; evidence_count: number }[]) {
    mastery[r.skill] = { estimate: Number(r.ai_estimate), evidence: r.evidence_count };
  }
  return {
    session: s,
    ctx: {
      sessionId: s.id, studentId: s.student_id, yearGroup: profile.year_group, mode: s.mode, level: s.level,
      versionId: s.book_version_id, lessonId: s.lesson_id, lessonTitle, currentPage: s.current_page,
      objective: s.objective, mastery,
    },
  };
}

/** Last N text turns as model messages. Rows whose text was not retained (privacy setting) are skipped. */
export async function loadHistory(db: SupabaseClient, sessionId: string, limit = 16) {
  const { data } = await db
    .from("session_events")
    .select("type, payload, seq")
    .eq("session_id", sessionId)
    .in("type", ["user_text", "assistant_text", "user_speech", "assistant_speech"])
    .order("seq", { ascending: false })
    .limit(limit);
  const rows = ((data ?? []) as { type: string; payload: { text?: string } | null; seq: number }[]).reverse();
  return rows
    .filter((r) => typeof r.payload?.text === "string" && r.payload.text.length > 0)
    .map((r) => ({ role: r.type.startsWith("user") ? ("user" as const) : ("assistant" as const), content: r.payload!.text! }));
}

export interface EventInput {
  type: "user_text" | "assistant_text" | "user_speech" | "assistant_speech" | "vision_recognition" | "page_confirmed" | "page_rejected" | "state" | "safety_flag" | "error";
  payload: Record<string, unknown>;
  sources?: unknown[];
}

/**
 * Append a session event as the student (RLS-checked). When the student opted out of transcript retention,
 * text is not stored — only metadata and source references.
 */
export async function appendEvent(db: SupabaseClient, sessionId: string, e: EventInput, retainText: boolean) {
  const payload = { ...e.payload };
  if (!retainText) {
    delete payload.text;
    delete payload.answer;
    payload.redacted = true;
  }
  const { error } = await db.rpc("append_session_event", { p_session: sessionId, p_type: e.type, p_payload: payload, p_sources: e.sources ?? [] });
  if (error) throw new Error(`append_session_event failed: ${error.message}`);
}

export function sourcesOf(a: VerifiedAnswer) {
  return a.sources.map((s) => ({ chunkId: s.chunkId, lesson: s.lessonTitle, pageStart: s.pageStart, pageEnd: s.pageEnd }));
}

/** Fold tutor-recorded evidence into skill_mastery (server-written AI estimate). */
export async function applyEvidence(admin: SupabaseClient, studentId: string, lessonId: string | null, evidence: Evidence[]) {
  for (const ev of evidence) {
    let q = admin.from("skill_mastery").select("id, ai_estimate, evidence_count").eq("student_id", studentId).eq("skill", ev.skill);
    q = lessonId ? q.eq("lesson_id", lessonId) : q.is("lesson_id", null);
    const { data: existing } = await q.maybeSingle();
    const prev: MasteryState | undefined = existing
      ? { estimate: Number((existing as { ai_estimate: number }).ai_estimate), evidence: (existing as { evidence_count: number }).evidence_count }
      : undefined;
    const next = updateMastery(prev, ev.outcome, ev.hintsUsed);
    if (existing) {
      await admin.from("skill_mastery").update({ ai_estimate: next.estimate, evidence_count: next.evidence, updated_at: new Date().toISOString() }).eq("id", (existing as { id: string }).id);
    } else {
      await admin.from("skill_mastery").insert({ student_id: studentId, skill: ev.skill, lesson_id: lessonId, ai_estimate: next.estimate, evidence_count: next.evidence });
    }
  }
}

export interface LoadedPage {
  pageNumber: number;
  printedLabel: string | null;
  text: string;
  lessonId: string | null;
  lessonTitle: string | null;
  bookTitle: string;
  objectives: string[]; // teacher-verified only
}

/** Validated page context straight from the database (never from the camera/OCR). RLS applies. */
export async function loadPageContext(db: SupabaseClient, versionId: string, pageNumber: number): Promise<LoadedPage | null> {
  const { data: rows, error } = await db.rpc("get_page_text", { p_book_version_id: versionId, p_page_number: pageNumber });
  if (error) throw new Error(`get_page_text failed: ${error.message}`);
  const page = (rows as { page_number: number; printed_label: string | null; text: string; lesson_id: string | null; lesson_title: string | null }[] | null)?.[0];
  if (!page) return null;
  const [{ data: bv }, { data: lesson }] = await Promise.all([
    db.from("book_versions").select("books(title)").eq("id", versionId).single(),
    page.lesson_id ? db.from("lessons").select("learning_objectives, verified_at").eq("id", page.lesson_id).single() : Promise.resolve({ data: null }),
  ]);
  const books = (bv as { books: { title: string } | { title: string }[] | null } | null)?.books;
  const l = lesson as { learning_objectives: string[]; verified_at: string | null } | null;
  return {
    pageNumber: page.page_number,
    printedLabel: page.printed_label,
    text: page.text,
    lessonId: page.lesson_id,
    lessonTitle: page.lesson_title,
    bookTitle: (Array.isArray(books) ? books[0]?.title : books?.title) ?? "الكتاب",
    objectives: l?.verified_at ? (l.learning_objectives ?? []) : [],
  };
}
