"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { VerifiedAnswer } from "@/lib/tutor/answer";
import { mergeVoiceTranscript, type BookOption, type ChatMessage, type SessionState } from "@/lib/tutor/client-types";
import { buildModeSwitchMessage } from "@/lib/tutor/prompt";
import { type Level, type Mode } from "@/lib/tutor/types";
import type { ConfirmedPage, RecognitionResult } from "@/lib/vision/client-types";
import { AnswerView } from "./AnswerView";
import { CameraPanel } from "./CameraPanel";
import { LessonCard } from "./LessonCard";
import { ModeTabs } from "./ModeTabs";
import { useVoiceSession, supportsVoice } from "./useVoiceSession";
import { VoicePanel } from "./VoicePanel";

const LEVEL_AR: Record<Level, string> = { support: "دعم", core: "أساسي", challenge: "تحدٍّ" };
let counter = 0;
const nid = () => `m${++counter}`;

export function TutorWorkspace({ books }: { books: BookOption[] }) {
  const [versionId, setVersionId] = useState<string | null>(books[0]?.versionId ?? null);
  const [lessonId, setLessonId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("explain");
  const [level, setLevel] = useState<Level>("core");
  const [session, setSession] = useState<SessionState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recognition, setRecognition] = useState<RecognitionResult | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmedPage | null>(null);
  const [visionBusy, setVisionBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const pageContextRef = useRef<string | null>(null);
  const [voiceSupported, setVoiceSupported] = useState(false);
  useEffect(() => setVoiceSupported(supportsVoice()), []);

  const book = books.find((b) => b.versionId === versionId) ?? null;
  const lesson = book?.lessons.find((l) => l.id === lessonId) ?? null;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const ensureSession = useCallback(async (): Promise<SessionState> => {
    if (session && session.versionId === versionId && session.lessonId === lessonId) return session;
    const r = await fetch("/api/sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, level, versionId, lessonId, channel: "text" }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message ?? "تعذّر بدء الجلسة");
    const s: SessionState = { id: j.session.id, mode, level, versionId, lessonId };
    setSession(s);
    return s;
  }, [session, versionId, lessonId, mode, level]);

  const voice = useVoiceSession({
    getSessionId: async () => (await ensureSession()).id,
    getResumeContext: () => pageContextRef.current,
  });
  const voiceLive = voice.state.phase === "live";

  // Fold the live voice transcript into the shared conversation log.
  useEffect(() => {
    if (voice.state.transcript.length) setMessages((m) => mergeVoiceTranscript(m, voice.state.transcript));
  }, [voice.state.transcript]);

  async function changeMode(m: Mode) {
    setMode(m);
    if (session) {
      void fetch(`/api/sessions/${session.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: m }) }).catch(() => undefined);
    }
    if (voiceLive) voice.pushContext(buildModeSwitchMessage(m, level), { speak: false });
  }

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    if (voiceLive) {
      // One conversation: typed input goes to the live voice session.
      setDraft("");
      voice.sendText(t);
      return;
    }
    setBusy(true);
    setError(null);
    setDraft("");
    setMessages((m) => [...m, { id: nid(), role: "student", text: t, via: "text" }]);
    try {
      const s = await ensureSession();
      const r = await fetch("/api/tutor/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: s.id, text: t, mode }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message ?? "حدث خطأ");
      setMessages((m) => [...m, { id: nid(), role: "tutor", answer: j.answer as VerifiedAnswer, via: "text" }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر الاتصال. تحقق من الشبكة وحاول مجددًا.");
    } finally {
      setBusy(false);
    }
  }

  const addSystem = (text: string) => setMessages((m) => [...m, { id: nid(), role: "system", text }]);

  const handleCapture = useCallback(
    async (jpeg: Blob) => {
      if (!versionId) return setError("اختر الكتاب أولًا ثم التقط الصفحة.");
      setVisionBusy(true);
      setError(null);
      try {
        const s = await ensureSession();
        const fd = new FormData();
        fd.set("sessionId", s.id);
        fd.set("image", jpeg, "page.jpg");
        const r = await fetch("/api/vision/recognize", { method: "POST", body: fd });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error?.message ?? "تعذّر تحليل الصورة");
        setRecognition(j as RecognitionResult);
      } catch (e) {
        setError(e instanceof Error ? e.message : "تعذّر تحليل الصورة. تحقق من الشبكة.");
      } finally {
        setVisionBusy(false);
      }
    },
    [versionId, ensureSession],
  );

  async function confirmPage(pageNumber: number, source: "camera" | "manual") {
    setVisionBusy(true);
    setError(null);
    try {
      const s = await ensureSession();
      const r = await fetch("/api/vision/confirm", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: s.id, pageNumber, source }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message ?? "تعذّر تأكيد الصفحة");
      const ctx = j.context as ConfirmedPage;
      pageContextRef.current = typeof j.contextMessage === "string" ? j.contextMessage : null;
      // Live voice: hand the validated page to the tutor immediately — no reconnect, no restart.
      if (pageContextRef.current) voice.pushContext(pageContextRef.current);
      setConfirmed(ctx);
      setRecognition(null);
      if (ctx.lessonId && book?.lessons.some((l) => l.id === ctx.lessonId)) {
        setLessonId(ctx.lessonId);
        setSession({ ...s, lessonId: ctx.lessonId });
      }
      addSystem(`تم تأكيد الصفحة ${pageNumber}${ctx.lessonTitle ? ` — ${ctx.lessonTitle}` : ""}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر تأكيد الصفحة");
    } finally {
      setVisionBusy(false);
    }
  }

  async function rejectPage(pageNumber: number) {
    setRecognition(null);
    if (!session) return;
    await fetch("/api/vision/confirm", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, pageNumber, source: "camera", accepted: false }),
    }).catch(() => undefined);
  }

  const select = "rounded-lg border border-line bg-surface px-3 py-2 text-sm";
  const noBooks = books.length === 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
      {/* Stage: the voice orb is the first and largest thing on screen. */}
      <div className="grid gap-4 md:grid-cols-[1fr_20rem] lg:col-span-2">
        <VoicePanel
          state={voice.state}
          supported={voiceSupported}
          disabled={noBooks}
          onStart={() => void voice.start()}
          onStop={() => void voice.stop()}
          onMute={voice.setMuted}
          onInterrupt={voice.interrupt}
        />

        <section aria-label="إعدادات الدرس" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
          <h2 className="font-bold">الكتاب والدرس</h2>
          {noBooks ? (
            <p className="text-sm text-muted">لا توجد كتب جاهزة بعد. اطلب من المسؤول رفع كتاب.</p>
          ) : (
            <>
              <label className="block text-sm">الكتاب
                <select className={`${select} mt-1 w-full`} value={versionId ?? ""} onChange={(e) => { setVersionId(e.target.value || null); setLessonId(null); }}>
                  {books.map((b) => <option key={b.versionId} value={b.versionId}>{b.title}</option>)}
                </select>
              </label>
              <label className="block text-sm">الدرس
                <select className={`${select} mt-1 w-full`} value={lessonId ?? ""} onChange={(e) => setLessonId(e.target.value || null)}>
                  <option value="">— الكتاب كاملًا —</option>
                  {book?.lessons.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
                </select>
              </label>
              {lesson && <p className="text-xs text-muted">الصفحات {lesson.startPage}–{lesson.endPage}{lesson.unit ? ` · ${lesson.unit}` : ""}</p>}
            </>
          )}
          <label className="block text-sm">المستوى
            <select className={`${select} mt-1 w-full`} value={level} onChange={(e) => setLevel(e.target.value as Level)}>
              {(Object.keys(LEVEL_AR) as Level[]).map((l) => <option key={l} value={l}>{LEVEL_AR[l]}</option>)}
            </select>
          </label>
        </section>
      </div>

      <aside className="space-y-4" aria-label="الكاميرا والصفحة">
        <CameraPanel onCapture={handleCapture} disabled={visionBusy || noBooks} />
        <LessonCard
          recognition={recognition}
          confirmed={confirmed}
          busy={visionBusy}
          onConfirm={(n, src) => void confirmPage(n, src)}
          onReject={(n) => void rejectPage(n)}
          onChange={() => { setConfirmed(null); setRecognition(null); }}
          onExplain={() => void send(`اشرح لي ما في الصفحة ${confirmed?.pageNumber ?? ""} من الدرس.`)}
        />
      </aside>

      <section className="flex min-h-[32rem] flex-col rounded-2xl border border-line bg-surface" aria-label="المحادثة">
        <div className="space-y-3 border-b border-line p-4">
          <ModeTabs value={mode} onChange={(m) => void changeMode(m)} />
        </div>
        <div ref={logRef} role="log" aria-live="polite" aria-label="سجل المحادثة" className="flex-1 space-y-4 overflow-y-auto p-4" style={{ maxHeight: "60vh" }}>
          {messages.length === 0 && !voiceLive && (
            <p className="py-10 text-center text-muted">اكتب سؤالك عن الدرس، مثل: «ما هو الفاعل؟» أو اطلب تمرينًا.</p>
          )}
          {messages.map((m) => (
            <div key={m.id} className={m.role === "student" ? "flex justify-start" : "flex justify-end"}>
              <div className={`max-w-[90%] rounded-2xl px-4 py-3 ${m.role === "student" ? "bg-brand text-brand-ink" : "bg-bg ring-1 ring-line"}`}>
                {m.role === "student" && <p>{m.text}</p>}
                {m.role === "tutor" && <AnswerView answer={m.answer} />}
                {m.role === "tutor-text" && <p className={m.final ? "" : "opacity-80"}>{m.text}{m.interrupted ? " …" : ""}</p>}
                {m.role === "system" && <p className="text-sm text-muted">{m.text}</p>}
              </div>
            </div>
          ))}
          {busy && <p className="text-sm text-muted" aria-live="polite">المعلّم يبحث في الكتاب ويكتب…</p>}
          {voiceLive && messages.length === 0 && <p className="py-6 text-center text-muted">المحادثة الصوتية تعمل — تحدّث وسيظهر النص هنا.</p>}
        </div>
        {error && (
          <div role="alert" className="mx-4 mb-2 flex items-center justify-between gap-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
            <span>{error}</span>
            <button type="button" className="underline" onClick={() => setError(null)}>إغلاق</button>
          </div>
        )}
        <form className="flex gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
          <label className="sr-only" htmlFor="draft">اكتب رسالتك</label>
          <textarea
            id="draft" rows={2} value={draft} maxLength={2000} disabled={busy || noBooks}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(draft); } }}
            placeholder="اكتب سؤالك هنا…"
            className="min-h-12 flex-1 resize-none rounded-xl border border-line bg-bg px-3 py-2"
          />
          <button disabled={busy || !draft.trim() || noBooks} className="rounded-xl bg-brand px-5 font-semibold text-brand-ink disabled:opacity-50">إرسال</button>
        </form>
      </section>
    </div>
  );
}
