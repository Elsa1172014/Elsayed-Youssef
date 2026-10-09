"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

const HOME: Record<string, string> = { admin: "/admin/books", teacher: "/teacher", student: "/student" };

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.get("error") === "config" ? "لم يتم ضبط الخدمة بعد (متغيرات البيئة)." : null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error: err } = await supabase.auth.signInWithPassword({
        email: String(form.get("email")),
        password: String(form.get("password")),
      });
      if (err || !data.user) {
        setError("بيانات الدخول غير صحيحة.");
        return;
      }
      const { data: profile } = await supabase.from("profiles").select("role").eq("id", data.user.id).single();
      const next = params.get("next");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : (HOME[profile?.role ?? "student"] ?? "/student"));
      router.refresh();
    } catch {
      setError("تعذّر الاتصال بالخدمة. تحقق من الشبكة وحاول مجددًا.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-sm" aria-describedby={error ? "login-error" : undefined}>
      <h1 className="text-2xl font-bold">تسجيل الدخول</h1>
      <p className="text-sm text-muted">الحسابات تُنشأ من قِبل المدرسة. إن لم يكن لديك حساب فتواصل مع معلّمك.</p>
      <label className="block text-sm">
        البريد الإلكتروني
        <input name="email" type="email" required autoComplete="username" dir="ltr" className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2" />
      </label>
      <label className="block text-sm">
        كلمة المرور
        <input name="password" type="password" required autoComplete="current-password" dir="ltr" className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2" />
      </label>
      {error && <p id="login-error" role="alert" className="text-sm text-danger">{error}</p>}
      <button disabled={busy} className="w-full rounded-lg bg-brand px-4 py-2 font-semibold text-brand-ink disabled:opacity-60">
        {busy ? "جارٍ الدخول…" : "دخول"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
