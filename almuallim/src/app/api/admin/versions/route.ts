import { authorize } from "@/lib/auth/guard";
import { apiError, json } from "@/lib/http";

/** Admin: versions with their latest ingestion job (polled by the admin UI). Reads run under the admin's RLS. */
export async function GET() {
  const a = await authorize(["admin"]);
  if (!a.ok) return a.response;
  const { data: versions, error } = await a.auth.db
    .from("book_versions")
    .select("id, version_label, status, page_count, error, created_at, ready_at, books(id, title, year_min, year_max)")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return apiError("internal", "تعذّر جلب النسخ");
  const ids = (versions ?? []).map((v) => v.id);
  const { data: jobs } = ids.length
    ? await a.auth.db
        .from("ingestion_jobs")
        .select("book_version_id, status, stage, attempts, max_attempts, progress, error, created_at, finished_at")
        .in("book_version_id", ids)
        .order("created_at", { ascending: false })
    : { data: [] };
  const latest = new Map<string, NonNullable<typeof jobs>[number]>();
  for (const j of jobs ?? []) if (!latest.has(j.book_version_id)) latest.set(j.book_version_id, j);
  return json({ versions: (versions ?? []).map((v) => ({ ...v, job: latest.get(v.id) ?? null })) });
}
