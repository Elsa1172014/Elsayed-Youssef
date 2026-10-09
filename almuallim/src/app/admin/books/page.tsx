import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { BookManager } from "@/components/admin/BookManager";
import { getAuth } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function AdminBooksPage() {
  const auth = await getAuth();
  if (!auth) redirect("/login?next=/admin/books");
  if (auth.profile.role !== "admin") redirect("/");
  return (
    <AppShell role="admin" name={auth.profile.display_name}>
      <h1 className="mb-1 text-3xl font-bold">الكتب المدرسية</h1>
      <p className="mb-8 text-muted">ارفع كتابًا مرخّصًا بصيغة PDF؛ تتم المعالجة في خادم خلفي مستقل ويمكنك متابعة حالتها هنا.</p>
      <BookManager />
    </AppShell>
  );
}
