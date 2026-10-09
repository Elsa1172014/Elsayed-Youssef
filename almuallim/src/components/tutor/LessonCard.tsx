"use client";
import { useState } from "react";
import type { ConfirmedPage, RecognitionResult } from "@/lib/vision/client-types";

const pct = (n: number) => `${Math.round(n * 100)}٪`.replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]!);
const ar = (n: number) => String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]!);

function confidenceLabel(c: number) {
  return c >= 0.72 ? "ثقة عالية" : c >= 0.5 ? "ثقة متوسطة" : "ثقة منخفضة";
}

interface Props {
  recognition: RecognitionResult | null;
  confirmed: ConfirmedPage | null;
  busy: boolean;
  onConfirm: (pageNumber: number, source: "camera" | "manual") => void;
  onReject: (pageNumber: number) => void;
  onChange: () => void;
  onExplain?: () => void;
}

/** Shows what the system thinks the page is — always with confidence and always asking for confirmation. */
export function LessonCard({ recognition, confirmed, busy, onConfirm, onReject, onChange, onExplain }: Props) {
  const [manual, setManual] = useState("");
  const [picked, setPicked] = useState<number | null>(null);

  if (confirmed) {
    return (
      <section aria-label="الصفحة المؤكَّدة" className="space-y-2 rounded-2xl border border-ok/40 bg-ok/10 p-4">
        <p className="text-xs font-bold text-ok">✓ صفحة مؤكَّدة</p>
        <p className="font-bold">{confirmed.lessonTitle ?? "درس غير محدد"}</p>
        <p className="text-sm text-muted">{confirmed.bookTitle} · صفحة {ar(confirmed.pageNumber)}</p>
        {confirmed.objectives.length > 0 && (
          <ul className="list-disc ps-5 text-sm">{confirmed.objectives.map((o) => <li key={o}>{o}</li>)}</ul>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {onExplain && <button type="button" onClick={onExplain} className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-brand-ink">اشرح هذه الصفحة</button>}
          <button type="button" onClick={onChange} className="rounded-lg border border-line px-3 py-1.5 text-sm">تغيير الصفحة</button>
        </div>
      </section>
    );
  }

  const manualForm = (
    <form
      className="flex items-end gap-2 pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(manual);
        if (Number.isInteger(n) && n > 0) onConfirm(n, "manual");
      }}
    >
      <label className="flex-1 text-xs text-muted">أو اكتب رقم الصفحة
        <input inputMode="numeric" value={manual} onChange={(e) => setManual(e.target.value.replace(/\D/g, ""))} className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-1.5 text-sm text-ink" dir="ltr" />
      </label>
      <button disabled={busy || !manual} className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-50">اعتمد</button>
    </form>
  );

  if (!recognition) {
    return (
      <section aria-label="الصفحة" className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted">
        <p>وجّه الكاميرا إلى الصفحة؛ يلتقط النظام صورة عندما تثبت الكاميرا، أو اضغط «التقط الآن». لا تُرسَل صور إلا لحظة الالتقاط.</p>
        {manualForm}
      </section>
    );
  }

  if (recognition.status === "no_page" || recognition.decision === "none") {
    return (
      <section aria-label="نتيجة التعرّف" className="space-y-1 rounded-2xl border border-accent/40 bg-accent/10 p-4 text-sm">
        <p className="font-bold text-warn">لم أتعرّف على الصفحة</p>
        <p className="text-muted">{recognition.status === "no_page" ? "لم أرَ صفحة كتاب في الصورة." : "النص غير واضح أو الصفحة غير موجودة في الكتاب."} قرّب الصفحة وثبّتها في ضوء جيد، أو اكتب رقمها.</p>
        {manualForm}
      </section>
    );
  }

  const top = recognition.candidates[0]!;
  if (recognition.decision === "confident") {
    return (
      <section aria-label="نتيجة التعرّف" className="space-y-2 rounded-2xl border border-brand/40 bg-brand/5 p-4">
        <p className="text-xs font-bold text-brand">{confidenceLabel(recognition.confidence)} · {pct(recognition.confidence)}</p>
        <p className="font-bold">هل هذه صفحة {ar(top.pageNumber)}{top.lessonTitle ? ` — ${top.lessonTitle}` : ""}؟</p>
        <div className="flex gap-2">
          <button disabled={busy} onClick={() => onConfirm(top.pageNumber, "camera")} className="rounded-lg bg-brand px-4 py-1.5 text-sm font-semibold text-brand-ink disabled:opacity-50">نعم، هذه هي</button>
          <button disabled={busy} onClick={() => onReject(top.pageNumber)} className="rounded-lg border border-line px-4 py-1.5 text-sm">ليست هذه</button>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="نتيجة التعرّف" className="space-y-2 rounded-2xl border border-accent/40 bg-accent/10 p-4">
      <p className="text-xs font-bold text-warn">لست متأكدًا ({pct(recognition.confidence)}) — اختر الصفحة الصحيحة</p>
      <fieldset className="space-y-1">
        <legend className="sr-only">الصفحات المحتملة</legend>
        {recognition.candidates.map((c) => (
          <label key={c.pageNumber} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-bg">
            <input type="radio" name="cand" checked={picked === c.pageNumber} onChange={() => setPicked(c.pageNumber)} />
            <span>صفحة {ar(c.pageNumber)}{c.lessonTitle ? ` — ${c.lessonTitle}` : ""} <span className="text-xs text-muted">({pct(c.score)})</span></span>
          </label>
        ))}
      </fieldset>
      <div className="flex gap-2">
        <button disabled={busy || picked == null} onClick={() => picked != null && onConfirm(picked, "camera")} className="rounded-lg bg-brand px-4 py-1.5 text-sm font-semibold text-brand-ink disabled:opacity-50">أكّد الصفحة</button>
        <button disabled={busy} onClick={() => onReject(top.pageNumber)} className="rounded-lg border border-line px-4 py-1.5 text-sm">لا شيء منها</button>
      </div>
      {manualForm}
    </section>
  );
}
