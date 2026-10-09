import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { CreateClassForm } from "@/components/teacher/forms";
import { SKILL_LABEL_AR } from "@/lib/analytics/student";
import { getAuth } from "@/lib/auth/guard";
import { loadTeacherOverview } from "@/lib/teacher/data";

export const dynamic = "force-dynamic";

const ATTENTION = {
  "needs-support": { label: "يحتاج دعمًا", cls: "bg-danger/15 text-danger" },
  inactive: { label: "غير نشط", cls: "bg-accent/20 text-warn" },
  "no-data": { label: "لا بيانات بعد", cls: "bg-line text-muted" },
  ok: { label: "مستقر", cls: "bg-ok/15 text-ok" },
} as const;

export default async function TeacherPage() {
  const auth = await getAuth();
  if (!auth) redirect("/login?next=/teacher");
  if (auth.profile.role === "student") redirect("/student");
  const classes = await loadTeacherOverview(auth.db);
  return (
    <AppShell role={auth.profile.role} name={auth.profile.display_name}>
      <h1 className="mb-1 text-3xl font-bold">لوحة المعلّم</h1>
      <p className="mb-6 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm">
        المؤشرات هنا <strong>تقديرات آلية</strong> مبنية على إجابات الطالب مع المعلّم الآلي، وليست درجات رسمية. القيم التي تعتمدها أنت تظهر بعلامة «اعتماد المعلّم ✓» وتتقدّم دائمًا على التقدير الآلي.
      </p>
      <section className="mb-8 rounded-2xl border border-line bg-surface p-4"><CreateClassForm /></section>
      {classes.length === 0 && <p className="text-muted">لا توجد صفوف بعد. أنشئ صفًّا ثم اطلب من المسؤول إضافة الطلاب.</p>}
      <div className="space-y-8">
        {classes.map((c) => (
          <section key={c.id} aria-labelledby={`c-${c.id}`}>
            <h2 id={`c-${c.id}`} className="mb-2 text-xl font-bold">{c.name} <span className="text-sm font-normal text-muted">· الصف {c.yearGroup}</span></h2>
            {c.students.length === 0 ? (
              <p className="text-sm text-muted">لا يوجد طلاب في هذا الصف بعد.</p>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="bg-bg text-muted"><tr><th className="p-3 text-start">الطالب</th><th className="p-3 text-start">الحالة</th><th className="p-3 text-start">فجوات (تقدير آلي)</th><th className="p-3 text-start">جلسات</th><th className="p-3 text-start">آخر نشاط</th></tr></thead>
                  <tbody>
                    {c.students.map((s) => (
                      <tr key={s.id} className="border-t border-line">
                        <td className="p-3"><Link className="font-semibold text-brand underline" href={`/teacher/students/${s.id}`}>{s.displayName}</Link></td>
                        <td className="p-3"><span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${ATTENTION[s.attention].cls}`}>{ATTENTION[s.attention].label}</span></td>
                        <td className="p-3">{s.gaps.length ? s.gaps.map((g) => SKILL_LABEL_AR[g]).join("، ") : "—"}</td>
                        <td className="p-3">{s.sessions}</td>
                        <td className="p-3">{s.lastActive ? new Date(s.lastActive).toLocaleDateString("ar-AE") : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}
      </div>
    </AppShell>
  );
}
