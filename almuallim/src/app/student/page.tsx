import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { TutorWorkspace } from "@/components/tutor/TutorWorkspace";
import { getAuth } from "@/lib/auth/guard";
import type { BookOption } from "@/lib/tutor/client-types";

export const dynamic = "force-dynamic";

export default async function StudentPage() {
  const auth = await getAuth();
  if (!auth) redirect("/login?next=/student");

  // RLS limits students to READY versions; staff see all (they can preview in-progress books).
  const { data: versions } = await auth.db
    .from("book_versions")
    .select("id, version_label, status, books(title, year_min, year_max)")
    .eq("status", "ready")
    .order("created_at", { ascending: false });
  const ids = (versions ?? []).map((v) => v.id);
  const { data: lessons } = ids.length
    ? await auth.db.from("lessons").select("id, book_version_id, title, unit_title, start_page, end_page, ordinal").in("book_version_id", ids).order("ordinal")
    : { data: [] };

  const books: BookOption[] = (versions ?? []).map((v) => {
    const b = (Array.isArray(v.books) ? v.books[0] : v.books) as { title: string } | null;
    return {
      versionId: v.id,
      title: b?.title ?? "كتاب",
      lessons: (lessons ?? []).filter((l) => l.book_version_id === v.id).map((l) => ({ id: l.id, title: l.title, unit: l.unit_title, startPage: l.start_page, endPage: l.end_page })),
    };
  });

  return (
    <AppShell role={auth.profile.role} name={auth.profile.display_name}>
      <TutorWorkspace books={books} />
    </AppShell>
  );
}
