import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { NextResponse } from "next/server";
import { EnvError } from "@/lib/env";
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

type AuthState = { status: "ok"; auth: AuthContext } | { status: "unauthenticated" } | { status: "not_configured" };

/** Resolve the caller from the session cookie. Always re-validates the JWT with Supabase Auth. */
export async function getAuthState(): Promise<AuthState> {
  let db: SupabaseClient;
  try {
    db = await createSupabaseServerClient();
  } catch (e) {
    if (e instanceof EnvError) return { status: "not_configured" };
    throw e;
  }
  const { data } = await db.auth.getUser();
  if (!data.user) return { status: "unauthenticated" };
  const { data: profile } = await db
    .from("profiles")
    .select("id, role, display_name, year_group, allow_transcript_retention")
    .eq("id", data.user.id)
    .single();
  if (!profile) return { status: "unauthenticated" };
  return { status: "ok", auth: { user: data.user, profile: profile as Profile, db } };
}

export async function getAuth(): Promise<AuthContext | null> {
  const s = await getAuthState();
  return s.status === "ok" ? s.auth : null;
}

/** For route handlers: returns the auth context or a ready-made 401/403 response. */
export async function authorize(allowed: readonly Role[]): Promise<{ ok: true; auth: AuthContext } | { ok: false; response: NextResponse }> {
  const st = await getAuthState();
  if (st.status === "not_configured") return { ok: false, response: apiError("not_configured", "الخدمة غير مهيّأة بعد (إعدادات Supabase ناقصة).") };
  if (st.status !== "ok") return { ok: false, response: apiError("unauthenticated", "يلزم تسجيل الدخول") };
  const auth = st.auth;
  if (!roleAllows(auth.profile.role, allowed)) return { ok: false, response: apiError("forbidden", "غير مصرّح لك بهذا الإجراء") };
  return { ok: true, auth };
}
