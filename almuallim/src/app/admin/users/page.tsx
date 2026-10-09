import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { CreateUserForm } from "@/components/teacher/forms";
import { getAuth } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const auth = await getAuth();
  if (!auth) redirect("/login?next=/admin/users");
  if (auth.profile.role !== "admin") redirect("/");
  const { data: classes } = await auth.db.from("classes").select("id, name").order("name");
  return (
    <AppShell role="admin" name={auth.profile.display_name}>
      <h1 className="mb-1 text-3xl font-bold">الحسابات المدرسية</h1>
      <p className="mb-6 max-w-2xl text-muted">لا يوجد تسجيل ذاتي للطلاب. تُنشأ الحسابات من قِبل المدرسة بأقل قدر من البيانات: بريد (يُفضَّل مستعار) واسم ظاهر وصف دراسي.</p>
      <div className="max-w-xl"><CreateUserForm classes={classes ?? []} /></div>
    </AppShell>
  );
}
