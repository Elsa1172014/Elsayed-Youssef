import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto grid min-h-screen max-w-3xl place-items-center px-6 py-16">
      <div className="space-y-6 text-center">
        <span aria-hidden className="mx-auto grid size-16 place-items-center rounded-full bg-brand text-3xl font-bold text-brand-ink">ع</span>
        <h1 className="text-4xl font-bold leading-tight">المعلّم العربي الذكي</h1>
        <p className="text-lg text-muted">
          معلّم صوتي لمادة اللغة العربية للصفوف ٧–١٣، يشرح من كتابك المدرسي المعتمد: وجّه الكاميرا إلى الصفحة وتحدّث معه.
        </p>
        <Link href="/login" className="inline-block rounded-xl bg-brand px-6 py-3 font-semibold text-brand-ink">
          تسجيل الدخول
        </Link>
      </div>
    </main>
  );
}
