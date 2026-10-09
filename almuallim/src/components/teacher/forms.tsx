"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

async function call(url: string, method: string, body: unknown): Promise<{ ok: boolean; message?: string; data?: unknown }> {
  try {
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, data: j } : { ok: false, message: j?.error?.message ?? "تعذّر الحفظ" };
  } catch {
    return { ok: false, message: "تعذّر الاتصال. تحقق من الشبكة." };
  }
}
const input = "rounded-lg border border-line bg-bg px-2 py-1 text-sm";

export function ValidateResponseForm({ responseId, initialScore, initialFeedback }: { responseId: string; initialScore: number | null; initialFeedback: string | null }) {
  const router = useRouter();
  const [score, setScore] = useState(initialScore?.toString() ?? "");
  const [feedback, setFeedback] = useState(initialFeedback ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const r = await call(`/api/teacher/responses/${responseId}`, "PATCH", { teacherScore: Number(score), teacherFeedback: feedback || undefined });
        setBusy(false);
        setMsg(r.ok ? "تم الحفظ ✓" : (r.message ?? "خطأ"));
        if (r.ok) router.refresh();
      }}
    >
      <label className="text-xs text-muted">درجتك (٠–١٠٠)
        <input type="number" min={0} max={100} required value={score} onChange={(e) => setScore(e.target.value)} className={`${input} mt-1 block w-24`} dir="ltr" />
      </label>
      <label className="min-w-48 flex-1 text-xs text-muted">ملاحظتك للطالب
        <input value={feedback} maxLength={1000} onChange={(e) => setFeedback(e.target.value)} className={`${input} mt-1 block w-full`} />
      </label>
      <button disabled={busy || score === ""} className="rounded-lg bg-brand px-3 py-1 text-sm font-semibold text-brand-ink disabled:opacity-50">{initialScore != null ? "تحديث الاعتماد" : "اعتماد"}</button>
      <span role="status" aria-live="polite" className="text-xs text-muted">{msg}</span>
    </form>
  );
}

export function ValidateSkillForm({ studentId, skill, initial }: { studentId: string; skill: string; initial: number | null }) {
  const router = useRouter();
  const [v, setV] = useState(initial == null ? "" : String(Math.round(initial * 100)));
  const [msg, setMsg] = useState<string | null>(null);
  async function save(value: number | null) {
    const r = await call("/api/teacher/mastery", "PUT", { studentId, skill, lessonId: null, value });
    setMsg(r.ok ? "تم ✓" : (r.message ?? "خطأ"));
    if (r.ok) router.refresh();
  }
  return (
    <div className="flex items-center gap-1">
      <label className="sr-only" htmlFor={`v-${skill}`}>اعتماد {skill}</label>
      <input id={`v-${skill}`} type="number" min={0} max={100} value={v} onChange={(e) => setV(e.target.value)} className={`${input} w-16`} dir="ltr" />
      <button type="button" disabled={v === ""} onClick={() => void save(Number(v) / 100)} className="rounded-lg border border-line px-2 py-1 text-xs disabled:opacity-40">اعتمد</button>
      {initial != null && <button type="button" onClick={() => void save(null)} className="text-xs text-muted underline">مسح</button>}
      <span role="status" aria-live="polite" className="text-xs text-muted">{msg}</span>
    </div>
  );
}

export function CreateClassForm() {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const r = await call("/api/teacher/classes", "POST", { name: fd.get("name"), yearGroup: Number(fd.get("yearGroup")) });
        setMsg(r.ok ? "تم إنشاء الصف ✓" : (r.message ?? "خطأ"));
        if (r.ok) { (e.target as HTMLFormElement).reset(); router.refresh(); }
      }}
    >
      <label className="text-sm">اسم الصف<input name="name" required maxLength={80} className={`${input} mt-1 block`} placeholder="٩/أ" /></label>
      <label className="text-sm">الصف الدراسي<input name="yearGroup" type="number" min={7} max={13} defaultValue={9} required className={`${input} mt-1 block w-24`} /></label>
      <button className="rounded-lg bg-brand px-4 py-1.5 text-sm font-semibold text-brand-ink">إنشاء صف</button>
      <span role="status" aria-live="polite" className="text-sm text-muted">{msg}</span>
    </form>
  );
}

export function CreateUserForm({ classes }: { classes: { id: string; name: string }[] }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [pw, setPw] = useState<string | null>(null);
  const [role, setRole] = useState("student");
  return (
    <form
      className="space-y-3 rounded-2xl border border-line bg-surface p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const r = await call("/api/admin/users", "POST", {
          email: fd.get("email"), displayName: fd.get("displayName") || "", role,
          yearGroup: role === "student" ? Number(fd.get("yearGroup")) : null, classId: fd.get("classId") || null, consentRecorded: fd.get("consent") === "on",
        });
        setPw(r.ok ? (r.data as { temporaryPassword: string }).temporaryPassword : null);
        setMsg(r.ok ? "تم إنشاء الحساب. سلّم كلمة المرور المؤقتة للمستخدم الآن؛ لن تظهر مرة أخرى." : (r.message ?? "خطأ"));
        if (r.ok) (e.target as HTMLFormElement).reset();
      }}
    >
      <h2 className="text-xl font-bold">إنشاء حساب مدرسي</h2>
      <label className="block text-sm">البريد الإلكتروني (يُفضَّل بريد مدرسي مستعار للطلاب)<input name="email" type="email" required className={`${input} mt-1 block w-full`} dir="ltr" /></label>
      <label className="block text-sm">الاسم الظاهر (الاسم الأول أو اسم مستعار)<input name="displayName" maxLength={80} className={`${input} mt-1 block w-full`} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">الدور
          <select value={role} onChange={(e) => setRole(e.target.value)} className={`${input} mt-1 block w-full`}>
            <option value="student">طالب</option><option value="teacher">معلّم</option><option value="admin">مسؤول</option>
          </select>
        </label>
        {role === "student" && <label className="block text-sm">الصف<input name="yearGroup" type="number" min={7} max={13} defaultValue={9} className={`${input} mt-1 block w-full`} /></label>}
      </div>
      {role === "student" && (
        <>
          <label className="block text-sm">الصف الدراسي (الشعبة)
            <select name="classId" className={`${input} mt-1 block w-full`}><option value="">— بدون —</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
          <label className="flex items-start gap-2 text-sm"><input name="consent" type="checkbox" className="mt-1.5" /><span>تم تسجيل موافقة المدرسة/ولي الأمر على استخدام المنصة.</span></label>
        </>
      )}
      <button className="rounded-lg bg-brand px-4 py-2 font-semibold text-brand-ink">إنشاء</button>
      <p role="status" aria-live="polite" className="text-sm text-muted">{msg}</p>
      {pw && <p className="rounded-lg bg-accent/15 px-3 py-2 text-sm">كلمة المرور المؤقتة: <code dir="ltr" className="font-mono font-bold">{pw}</code></p>}
    </form>
  );
}
