"use client";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="rounded border border-line px-3 py-1 hover:bg-bg"
      onClick={async () => {
        await createSupabaseBrowserClient().auth.signOut();
        router.replace("/login");
        router.refresh();
      }}
    >
      تسجيل الخروج
    </button>
  );
}
