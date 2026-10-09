import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type Role = "admin" | "teacher" | "student";
export interface Profile {
  id: string;
  role: Role;
  display_name: string;
  year_group: number | null;
  allow_transcript_retention: boolean;
}
export interface AuthContext {
  user: User;
  profile: Profile;
  /** Client acting as the user — RLS applies. */
  db: SupabaseClient;
}

export const roleAllows = (role: Role, allowed: readonly Role[]) => allowed.includes(role);

/** Resolve the caller from the session cookie. Always re-validates the JWT with Supabase Auth. */
export async function getAuth(): Promise<AuthContext | null> {
  const db = await createSupabaseServerClient();
  const { data } = await db.auth.getUser();
  if (!data.user) return null;
  const { data: profile } = await db
    .from("profiles")
    .select("id, role, display_name, year_group, allow_transcript_retention")
    .eq("id", data.user.id)
    .single();
  if (!profile) return null;
  return { user: data.user, profile: profile as Profile, db };
}

/** For route handlers: returns the auth context or a ready-made 401/403 response. */
export async function authorize(allowed: readonly Role[]): Promise<{ ok: true; auth: AuthContext } | { ok: false; response: NextResponse }> {
  const auth = await getAuth();
  if (!auth) return { ok: false, response: apiError("unauthenticated", "يلزم تسجيل الدخول") };
  if (!roleAllows(auth.profile.role, allowed)) return { ok: false, response: apiError("forbidden", "غير مصرّح لك بهذا الإجراء") };
  return { ok: true, auth };
}
