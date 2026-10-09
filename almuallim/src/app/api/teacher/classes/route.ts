import { authorize } from "@/lib/auth/guard";
import { apiError, json, parseBody } from "@/lib/http";
import { createClassSchema } from "@/lib/schemas/admin";

/** Teachers create their own classes (RLS: classes_insert requires teacher_id = caller). */
export async function POST(req: Request) {
  const a = await authorize(["teacher", "admin"]);
  if (!a.ok) return a.response;
  const body = await parseBody(req, createClassSchema);
  if (!body.ok) return body.response;
  const { data, error } = await a.auth.db
    .from("classes").insert({ name: body.data.name, year_group: body.data.yearGroup, teacher_id: a.auth.profile.id }).select("id, name, year_group").single();
  if (error || !data) return apiError("internal", "تعذّر إنشاء الصف");
  return json({ class: data }, { status: 201 });
}
