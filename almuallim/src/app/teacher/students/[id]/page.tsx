import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { ValidateResponseForm, ValidateSkillForm } from "@/components/teacher/forms";
import { AiBadge, pctAr, SkillBars, StatusChip, TeacherBadge } from "@/components/teacher/bits";
import { MIN_EVIDENCE, SKILL_LABEL_AR } from "@/lib/analytics/student";
import { getAuth } from "@/lib/auth/guard";
import { CONCERN_LABEL_AR, type ConcernCategory } from "@/lib/safety/concerns";
import { uuidSchema } from "@/lib/schemas/admin";
import { loadStudentDetail } from "@/lib/teacher/data";
import { MODE_LABEL_AR, type Mode } from "@/lib/tutor/types";

export const dynamic = "force-dynamic";

export default async function StudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  if (auth.profile.role === "student") redirect("/student");
  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) notFound();
  const d = await loadStudentDetail(auth.db, id.data);
  if (!d) notFound(); // not visible under RLS = not this teacher's student
  const a = d.analysis;

  return (
    <AppShell role={auth.profile.role} name={auth.profile.display_name}>
      <Link href="/teacher" className="text-sm text-brand underline">← لوحة المعلّم</Link>
      <h1 className="mb-1 mt-2 text-3xl font-bold">{d.profile.displayName}</h1>
      <p className="mb-6 text-muted">{d.profile.yearGroup ? `الصف ${d.profile.yearGroup}` : ""}</p>

      {d.safetyFlags.length > 0 && (
        <section role="alert" aria-labelledby="safe-h" className="mb-6 rounded-2xl border-2 border-danger bg-danger/10 p-4">
          <h2 id="safe-h" className="mb-1 text-lg font-bold text-danger">تنبيه حماية الطفل</h2>
          <p className="text-sm">رصد النظام آليًا عبارات قد تدل على ضيق أو خطر في {d.safetyFlags.length} رسالة/رسائل. هذا الرصد بالكلمات المفتاحية وقد يخطئ أو يفوته شيء. <strong>اتبع سياسة الحماية في مدرستك وأبلغ مسؤول الحماية عند الحاجة</strong>؛ لا تُحفظ نصوص الرسائل في هذا التنبيه.</p>
          <ul className="mt-2 list-disc ps-5 text-sm">{d.safetyFlags.map((f, i) => <li key={i}>{CONCERN_LABEL_AR[f.category as ConcernCategory] ?? f.category} — {new Date(f.createdAt).toLocaleString("ar-AE")} ({f.via === "voice" ? "صوتي" : "نصي"})</li>)}</ul>
        </section>
      )}

      <section aria-labelledby="skills-h" className="mb-8">
        <h2 id="skills-h" className="mb-1 text-xl font-bold">المهارات</h2>
        <p className="mb-3 text-sm text-muted"><AiBadge /> تقدير مبني على إجابات الطالب مع المعلّم الآلي (يلزم {MIN_EVIDENCE} إجابات على الأقل لتصنيفه). <TeacherBadge /> قيمة تعتمدها أنت وتتقدّم على التقدير.</p>
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="bg-bg text-muted"><tr><th className="p-3 text-start">المهارة</th><th className="p-3 text-start">المستوى</th><th className="p-3 text-start">تقدير آلي</th><th className="p-3 text-start">اعتماد المعلّم (٪)</th><th className="p-3 text-start">الحالة</th></tr></thead>
            <tbody>
              {a.skills.map((s) => (
                <tr key={s.skill} className="border-t border-line align-top">
                  <td className="p-3 font-semibold">{SKILL_LABEL_AR[s.skill]}</td>
                  <td className="w-56 p-3"><SkillBars ai={s.aiEstimate} teacher={s.teacherValidated} skill={s.skill} /></td>
                  <td className="p-3">{s.aiEstimate == null ? "—" : <>{pctAr(s.aiEstimate)} <span className="text-xs text-muted">({s.evidence} إجابة)</span></>}</td>
                  <td className="p-3"><ValidateSkillForm studentId={d.profile.id} skill={s.skill} initial={s.teacherValidated} /></td>
                  <td className="p-3"><StatusChip status={s.status} /> <span className="block text-xs text-muted">{s.statusBasis === "teacher" ? "بحسب اعتمادك" : s.statusBasis === "ai-estimate" ? "بحسب التقدير الآلي" : ""}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="int-h" className="mb-8 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-line bg-surface p-4">
          <h2 id="int-h" className="mb-2 text-xl font-bold">اقتراحات تدخّل <span className="text-xs font-normal text-muted">(آلية — قرارك أنت)</span></h2>
          {a.interventions.length === 0 ? <p className="text-sm text-muted">لا توجد اقتراحات.</p> : (
            <ul className="space-y-2">
              {a.interventions.map((i, k) => (
                <li key={k} className="rounded-xl bg-bg p-3 text-sm">
                  <p>{i.text}</p>
                  <p className="mt-1 text-xs text-muted">الأساس: {i.basis}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-2xl border border-line bg-surface p-4">
          <h2 className="mb-2 text-xl font-bold">ملاحظات المعلّم الآلي</h2>
          <p className="text-sm text-muted">متوسط التلميحات لكل إجابة: {a.hintDependence ?? "—"}</p>
          <h3 className="mt-3 font-semibold">فهم خاطئ متكرر</h3>
          {a.misconceptions.length === 0 ? <p className="text-sm text-muted">لم يُرصد شيء.</p> : (
            <ul className="list-disc ps-5 text-sm">{a.misconceptions.map((m) => <li key={m.text}>{m.text} <span className="text-xs text-muted">(×{m.count})</span></li>)}</ul>
          )}
          <h3 className="mt-3 font-semibold">صفحات الكتاب التي رُجع إليها</h3>
          {d.sourcePages.length === 0 ? <p className="text-sm text-muted">—</p> : (
            <ul className="list-disc ps-5 text-sm">{d.sourcePages.map((p, i) => <li key={i}>ص {p.pages}{p.lesson ? ` — ${p.lesson}` : ""} <span className="text-xs text-muted">(×{p.count})</span></li>)}</ul>
          )}
        </div>
      </section>

      <section aria-labelledby="resp-h" className="mb-8">
        <h2 id="resp-h" className="mb-3 text-xl font-bold">آخر الإجابات</h2>
        {d.responses.length === 0 && <p className="text-sm text-muted">لا توجد إجابات مسجّلة بعد.</p>}
        <ul className="space-y-3">
          {d.responses.map((r) => (
            <li key={r.id} className="rounded-2xl border border-line bg-surface p-4">
              <p className="text-xs text-muted">{r.skill ? SKILL_LABEL_AR[r.skill] : ""} · {new Date(r.createdAt).toLocaleString("ar-AE")} · تلميحات: {r.hintsUsed}</p>
              {r.prompt && <p className="mt-1 font-semibold">{r.prompt}</p>}
              <p className="mt-1 rounded-lg bg-bg p-2 text-sm">{r.answer}</p>
              <p className="mt-2 text-sm"><AiBadge /> {r.aiScore == null ? "—" : `${pctAr(r.aiScore / 100)}`} {r.aiFeedback ? <span className="text-muted">— {r.aiFeedback}</span> : null}</p>
              {r.aiMisconception && <p className="text-xs text-warn">فهم خاطئ مرصود: {r.aiMisconception}</p>}
              {r.validated && <p className="mt-1 text-sm"><TeacherBadge /> {r.teacherScore != null ? pctAr(r.teacherScore / 100) : ""} {r.teacherFeedback ? <span className="text-muted">— {r.teacherFeedback}</span> : null}</p>}
              <ValidateResponseForm responseId={r.id} initialScore={r.teacherScore} initialFeedback={r.teacherFeedback} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="sess-h">
        <h2 id="sess-h" className="mb-2 text-xl font-bold">الجلسات الأخيرة</h2>
        <ul className="space-y-1 text-sm">
          {d.sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap gap-x-3">
              <span>{new Date(s.startedAt).toLocaleString("ar-AE")}</span>
              <span>{MODE_LABEL_AR[s.mode as Mode] ?? s.mode}</span>
              <span>{s.channel === "voice" ? "صوتية" : "نصية"}</span>
              {s.currentPage ? <span>آخر صفحة: {s.currentPage}</span> : null}
            </li>
          ))}
          {d.sessions.length === 0 && <li className="text-muted">لا جلسات.</li>}
        </ul>
      </section>
    </AppShell>
  );
}
