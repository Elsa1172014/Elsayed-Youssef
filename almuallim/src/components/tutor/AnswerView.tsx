import type { VerifiedAnswer } from "@/lib/tutor/answer";

const GROUNDING: Record<VerifiedAnswer["grounding"], { label: string; cls: string }> = {
  grounded: { label: "مبني على الكتاب", cls: "bg-ok/15 text-ok" },
  partial: { label: "جزئيًّا من الكتاب", cls: "bg-accent/20 text-warn" },
  ungrounded: { label: "من خارج الكتاب", cls: "bg-danger/15 text-danger" },
};

/** Renders a verified answer with textbook quotes visually separated from generated explanation. */
export function AnswerView({ answer }: { answer: VerifiedAnswer }) {
  const g = GROUNDING[answer.grounding];
  return (
    <div className="space-y-3">
      <span className={`inline-block rounded-full px-3 py-0.5 text-xs font-semibold ${g.cls}`}>{g.label}</span>
      {answer.segments.map((s, i) => {
        switch (s.kind) {
          case "quote":
            return (
              <figure key={i} className="rounded-xl border-s-4 border-brand bg-brand/5 px-4 py-3">
                <figcaption className="mb-1 text-xs font-semibold text-brand">
                  من الكتاب · {s.source.label}
                  {s.source.lessonTitle ? ` · ${s.source.lessonTitle}` : ""}
                </figcaption>
                <blockquote className="text-lg leading-loose">{s.text}</blockquote>
              </figure>
            );
          case "notice":
            return (
              <p key={i} role="note" className="rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-warn">
                {s.text}
              </p>
            );
          case "question":
            return (
              <p key={i} className="rounded-xl bg-surface px-4 py-3 font-semibold ring-1 ring-line">
                <span className="me-2 text-xs font-bold text-warn">سؤال</span>
                {s.text}
              </p>
            );
          case "hint":
            return (
              <p key={i} className="rounded-xl bg-bg px-4 py-2 text-sm ring-1 ring-line">
                <span className="me-2 text-xs font-bold text-muted">تلميح {s.level}</span>
                {s.text}
              </p>
            );
          default:
            return <p key={i}>{s.text}</p>;
        }
      })}
      {answer.droppedQuotes > 0 && (
        <p className="text-xs text-muted">حُذف {answer.droppedQuotes} اقتباس لم يمكن التحقق منه من نص الكتاب.</p>
      )}
      <p className="text-xs text-muted">الشرح من إعداد المعلّم الآلي وقد يخطئ؛ الاقتباسات وحدها منقولة من الكتاب.</p>
    </div>
  );
}
