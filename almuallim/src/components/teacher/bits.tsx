import { SKILL_LABEL_AR, type SkillStatus } from "@/lib/analytics/student";
import type { Skill } from "@/lib/tutor/types";

const STATUS: Record<SkillStatus, { label: string; cls: string }> = {
  strength: { label: "نقطة قوة", cls: "bg-ok/15 text-ok" },
  developing: { label: "قيد التطوّر", cls: "bg-accent/20 text-warn" },
  gap: { label: "فجوة", cls: "bg-danger/15 text-danger" },
  insufficient: { label: "بيانات غير كافية", cls: "bg-line text-muted" },
};
export const StatusChip = ({ status }: { status: SkillStatus }) => (
  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS[status].cls}`}>{STATUS[status].label}</span>
);

/** Badge that keeps AI estimates visually and verbally distinct from teacher-validated values. */
export const AiBadge = () => <span className="rounded border border-dashed border-muted px-1.5 text-[11px] text-muted">تقدير آلي</span>;
export const TeacherBadge = () => <span className="rounded bg-brand px-1.5 text-[11px] font-semibold text-brand-ink">اعتماد المعلّم ✓</span>;

const ar = (n: number) => String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]!);
export const pctAr = (x: number) => `${ar(Math.round(x * 100))}٪`;

/** Two bars per skill: dashed = AI estimate, solid = teacher validation. Values are also printed as text. */
export function SkillBars({ ai, teacher, skill }: { ai: number | null; teacher: number | null; skill: Skill }) {
  return (
    <div role="img" aria-label={`${SKILL_LABEL_AR[skill]}: ${ai == null ? "لا تقدير آلي" : `تقدير آلي ${pctAr(ai)}`}${teacher == null ? "" : `، اعتماد المعلّم ${pctAr(teacher)}`}`} className="space-y-1">
      <div className="h-2.5 overflow-hidden rounded-full bg-line"><div className="h-full border-e-2 border-dashed border-muted bg-muted/40" style={{ width: `${Math.round((ai ?? 0) * 100)}%` }} /></div>
      {teacher != null && <div className="h-2.5 overflow-hidden rounded-full bg-line"><div className="h-full bg-brand" style={{ width: `${Math.round(teacher * 100)}%` }} /></div>}
    </div>
  );
}
