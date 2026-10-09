import "server-only";
import { createClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env";

/**
 * Service-role client: BYPASSES row-level security. Only for trusted server code that has already
 * authorised the caller (rate limits, ledger, AI-written scores, privacy export/delete, queue).
 * `server-only` makes the build fail if this module is ever imported from client code.
 */
export function createSupabaseAdmin() {
  const env = serverEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
