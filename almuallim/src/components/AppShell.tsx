import Link from "next/link";
import type { Role } from "@/lib/auth/guard";
import { SignOutButton } from "./SignOutButton";

const NAV: Record<Role, { href: string; label: string }[]> = {
  student: [{ href: "/student", label: "الدرس" }, { href: "/privacy", label: "الخصوصية" }],
  teacher: [{ href: "/teacher", label: "لوحة المعلّم" }, { href: "/student", label: "تجربة الدرس" }, { href: "/privacy", label: "الخصوصية" }],
  admin: [{ href: "/admin/books", label: "الكتب" }, { href: "/teacher", label: "لوحة المعلّم" }, { href: "/student", label: "تجربة الدرس" }, { href: "/privacy", label: "الخصوصية" }],
};

export function AppShell({ role, name, children }: { role: Role; name: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:right-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        تخطَّ إلى المحتوى
      </a>
      <header className="border-b border-line bg-surface/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/" className="flex items-center gap-2 text-lg font-bold text-brand">
            <span aria-hidden className="grid size-8 place-items-center rounded-full bg-brand text-brand-ink">ع</span>
            المعلّم العربي الذكي
          </Link>
          <nav aria-label="التنقل الرئيسي" className="flex flex-1 flex-wrap gap-4 text-sm">
            {NAV[role].map((n) => (
              <Link key={n.href + n.label} href={n.href} className="rounded px-1 text-muted hover:text-ink">
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm text-muted">
            <span>{name || "مستخدم"}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-8">
        {children}
      </main>
    </div>
  );
}
