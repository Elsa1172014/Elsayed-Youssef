"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

interface JobInfo {
  status: string; stage: string; attempts: number; max_attempts: number; error: string | null;
  progress: { pages_total?: number; pages_done?: number; chunks_embedded?: number; chunks_total?: number; lessons?: number; summary?: { warnings?: string[] } };
}
interface VersionRow {
  id: string; version_label: string; status: string; page_count: number | null; error: string | null;
  books: { title: string; year_min: number; year_max: number } | null;
  job: JobInfo | null;
}

const STATUS_AR: Record<string, string> = {
  uploaded: "تم الرفع", processing: "قيد المعالجة", ready: "جاهز", failed: "فشل", archived: "مؤرشف",
};
const STAGE_AR: Record<string, string> = {
  queued: "في الانتظار", download: "تنزيل الملف", extract: "استخراج النص", images: "صور الصفحات",
  lessons: "تحديد الدروس", chunk: "تقسيم المحتوى", embed: "الفهرسة الدلالية", finalize: "إنهاء", done: "اكتمل",
};

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function BookManager() {
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/versions", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      setVersions((await r.json()).versions);
      setLoadError(null);
    } catch {
      setLoadError("تعذّر تحديث الحالة. سنعيد المحاولة تلقائيًا.");
    }
  }, []);

  const active = versions.some((v) => v.status === "processing" || v.status === "uploaded");
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), active ? 3000 : 15000);
    return () => clearInterval(t);
  }, [refresh, active]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const file = fd.get("file") as File | null;
    if (!file || file.size === 0) return setMsg({ kind: "error", text: "اختر ملف PDF." });
    if (file.type !== "application/pdf") return setMsg({ kind: "error", text: "الملف يجب أن يكون PDF." });
    setBusy(true);
    try {
      setMsg({ kind: "info", text: "جارٍ حساب بصمة الملف…" });
      const fileSha256 = await sha256Hex(file);
      setMsg({ kind: "info", text: "جارٍ تسجيل الكتاب…" });
      const create = await fetch("/api/admin/books", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: fd.get("title"), yearMin: Number(fd.get("yearMin")), yearMax: Number(fd.get("yearMax")),
          publisher: fd.get("publisher") || undefined, licenseConfirmed: fd.get("licenseConfirmed") === "on",
          licenseAttestation: fd.get("licenseAttestation"), fileSha256, fileSize: file.size,
        }),
      });
      const created = await create.json();
      if (!create.ok) throw new Error(created?.error?.message ?? "فشل تسجيل الكتاب");
      setMsg({ kind: "info", text: "جارٍ رفع الملف…" });
      const { error: upErr } = await createSupabaseBrowserClient()
        .storage.from("textbooks")
        .uploadToSignedUrl(created.upload.path, created.upload.token, file, { contentType: "application/pdf" });
      if (upErr) throw new Error("فشل رفع الملف: " + upErr.message);
      const ing = await fetch(`/api/admin/versions/${created.versionId}/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!ing.ok) throw new Error((await ing.json())?.error?.message ?? "فشل جدولة المعالجة");
      setMsg({ kind: "info", text: "تم الرفع وجدولة المعالجة. تابع الحالة أدناه." });
      formRef.current?.reset();
      await refresh();
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof Error ? err.message : "حدث خطأ غير متوقع" });
    } finally {
      setBusy(false);
    }
  }

  async function reingest(id: string) {
    const r = await fetch(`/api/admin/versions/${id}/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: true }) });
    setMsg(r.ok ? { kind: "info", text: "أُعيدت جدولة المعالجة." } : { kind: "error", text: "تعذّرت إعادة الجدولة." });
    await refresh();
  }

  const field = "mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2";
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,26rem)_1fr]">
      <form ref={formRef} onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-line bg-surface p-5">
        <h2 className="text-xl font-bold">رفع كتاب جديد</h2>
        <label className="block text-sm">عنوان الكتاب<input name="title" required maxLength={200} className={field} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">من الصف<input name="yearMin" type="number" min={7} max={13} defaultValue={7} required className={field} /></label>
          <label className="block text-sm">إلى الصف<input name="yearMax" type="number" min={7} max={13} defaultValue={7} required className={field} /></label>
        </div>
        <label className="block text-sm">الناشر (اختياري)<input name="publisher" maxLength={200} className={field} /></label>
        <label className="block text-sm">ملف PDF<input name="file" type="file" accept="application/pdf" required className={field} /></label>
        <fieldset className="space-y-2 rounded-lg border border-line p-3 text-sm">
          <legend className="px-1 font-semibold">إقرار الترخيص</legend>
          <label className="block">أساس الترخيص (عقد/إذن/ترخيص مدرسي)
            <textarea name="licenseAttestation" required minLength={10} maxLength={1000} rows={2} className={field} />
          </label>
          <label className="flex items-start gap-2">
            <input name="licenseConfirmed" type="checkbox" required className="mt-1.5" />
            <span>أُقرّ بأن لدى المدرسة ترخيصًا نظاميًا لاستخدام هذا الكتاب في هذا النظام.</span>
          </label>
        </fieldset>
        <button disabled={busy} className="w-full rounded-lg bg-brand px-4 py-2 font-semibold text-brand-ink disabled:opacity-60">
          {busy ? "جارٍ المعالجة…" : "رفع وبدء المعالجة"}
        </button>
        <p role="status" aria-live="polite" className={`min-h-6 text-sm ${msg?.kind === "error" ? "text-danger" : "text-muted"}`}>{msg?.text}</p>
      </form>

      <section aria-labelledby="versions-h" className="space-y-3">
        <h2 id="versions-h" className="text-xl font-bold">حالة المعالجة</h2>
        {loadError && <p role="alert" className="text-sm text-warn">{loadError}</p>}
        {versions.length === 0 && <p className="text-muted">لا توجد كتب بعد.</p>}
        <ul className="space-y-3">
          {versions.map((v) => {
            const p = v.job?.progress ?? {};
            const extractShare = p.pages_total ? (p.pages_done ?? 0) / p.pages_total : 0;
            const embedShare = p.chunks_total ? (p.chunks_embedded ?? 0) / p.chunks_total : 0;
            const pct = v.status === "ready" ? 100 : Math.round(extractShare * 40 + embedShare * 60);
            return (
              <li key={v.id} className="rounded-2xl border border-line bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold">{v.books?.title ?? "—"} <span className="text-sm text-muted">· نسخة {v.version_label}</span></p>
                    <p className="text-sm text-muted">الصفوف {v.books?.year_min}–{v.books?.year_max}{v.page_count ? ` · ${v.page_count} صفحة` : ""}</p>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-sm ${v.status === "ready" ? "bg-ok/15 text-ok" : v.status === "failed" ? "bg-danger/15 text-danger" : "bg-accent/15 text-warn"}`}>
                    {STATUS_AR[v.status] ?? v.status}
                  </span>
                </div>
                {v.job && v.status === "processing" && (
                  <div className="mt-3">
                    <div className="h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="تقدّم المعالجة">
                      <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="mt-1 text-sm text-muted">
                      {STAGE_AR[v.job.stage] ?? v.job.stage} · محاولة {v.job.attempts}/{v.job.max_attempts}
                      {v.job.error ? ` · آخر خطأ: ${v.job.error}` : ""}
                    </p>
                  </div>
                )}
                {v.status === "ready" && v.job?.progress.summary?.warnings?.length ? (
                  <ul className="mt-2 list-disc ps-5 text-sm text-warn">{v.job.progress.summary.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                ) : null}
                {v.status === "ready" && p.lessons ? <p className="mt-2 text-sm text-muted">{p.lessons} درسًا مكتشفًا — راجع حدود الدروس قبل الاستخدام.</p> : null}
                {v.error && <p className="mt-2 text-sm text-danger">{v.error}</p>}
                {(v.status === "failed" || v.status === "ready" || v.status === "uploaded") && (
                  <button onClick={() => void reingest(v.id)} className="mt-3 rounded-lg border border-line px-3 py-1 text-sm hover:bg-bg">
                    إعادة المعالجة
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
