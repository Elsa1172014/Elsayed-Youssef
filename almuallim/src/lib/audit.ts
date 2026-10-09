import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";

export interface AuditEntry {
  actorId: string | null;
  action: string;           // e.g. "book.create", "student.export", "student.delete"
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/** Append to audit_logs with the service-role client. Failure to audit is logged loudly but never hidden. */
export async function audit(admin: SupabaseClient, e: AuditEntry): Promise<void> {
  const { error } = await admin.from("audit_logs").insert({
    actor_id: e.actorId,
    action: e.action,
    target_type: e.targetType ?? null,
    target_id: e.targetId ?? null,
    metadata: e.metadata ?? {},
  });
  if (error) logger.error("audit write failed", { action: e.action, error: error.message });
}
