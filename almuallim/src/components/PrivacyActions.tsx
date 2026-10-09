"use client";
import { useState } from "react";

export function PrivacyActions({ retain: initialRetain }: { retain: boolean }) {
  const [retain, setRetain] = useState(initialRetain);
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function toggle(next: boolean) {
    setBusy(true);
    const r = await fetch("/api/privacy/preferences", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ allowTranscriptRetention: next }) });
    setBusy(false);
    if (r.ok) { setRetain(next); setMsg(next ? "سيُحفظ نص محادثاتك لمعلّمك." : "لن يُحفظ نص محادثاتك بعد الآن (تُحفظ البيانات الوصفية فقط)."); }
    else setMsg("تعذّر حفظ التفضيل.");
  }

  async function del() {
    setBusy(true);
    const r = await fetch("/api/privacy/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "learning_data", confirm }) });
    setBusy(false);
    const j = await r.json().catch(() => ({}));
    setMsg(r.ok ? "تم حذف سجلّ تعلّمك." : (j?.error?.message ?? "تعذّر الحذف."));
    if (r.ok) setConfirm("");
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h3 className="mb-2 font-bold">حفظ نص المحادثات</h3>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={retain} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
          اسمح بحفظ نص محادثاتي ليراجعه معلّمي
        </label>
      </section>
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h3 className="mb-2 font-bold">تنزيل بياناتي</h3>
        <a href="/api/privacy/export" className="inline-block rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-ink" download>تنزيل ملف JSON</a>
      </section>
      <section className="rounded-2xl border border-danger/40 bg-danger/5 p-4">
        <h3 className="mb-2 font-bold text-danger">حذف سجلّ التعلّم</h3>
        <p className="mb-2 text-sm">يحذف جلساتك ونصوصك وإجاباتك وتقديرات المهارات نهائيًا. لا يحذف حسابك (يتم عبر المدرسة).</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">اكتب «حذف» للتأكيد<input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="mt-1 block rounded-lg border border-line bg-bg px-3 py-1.5" /></label>
          <button disabled={busy || confirm !== "حذف"} onClick={() => void del()} className="rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-brand-ink disabled:opacity-40">حذف نهائي</button>
        </div>
      </section>
      <p role="status" aria-live="polite" className="text-sm text-muted">{msg}</p>
    </div>
  );
}
