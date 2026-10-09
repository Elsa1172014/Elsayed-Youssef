"use client";
import { MODES, MODE_LABEL_AR, type Mode } from "@/lib/tutor/types";

const HINT: Record<Mode, string> = {
  explain: "شرح مباشر من الكتاب",
  socratic: "أسئلة توصلك للجواب",
  practice: "تمارين بتلميحات",
  assessment: "أسئلة بلا تلميحات",
  review: "مراجعة نقاط الضعف",
};

export function ModeTabs({ value, onChange, disabled }: { value: Mode; onChange: (m: Mode) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="وضع التعلّم" className="flex flex-wrap gap-2">
      {MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          disabled={disabled}
          title={HINT[m]}
          onClick={() => onChange(m)}
          className={`rounded-full px-4 py-1.5 text-sm font-semibold ring-1 transition ${
            value === m ? "bg-brand text-brand-ink ring-brand" : "bg-surface text-ink ring-line hover:bg-bg"
          } disabled:opacity-50`}
        >
          {MODE_LABEL_AR[m]}
        </button>
      ))}
    </div>
  );
}
