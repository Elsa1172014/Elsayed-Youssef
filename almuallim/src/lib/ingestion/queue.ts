import type { Queryable } from "./pg-store";
import { LeaseLostError, type JobContext, type Stage } from "./ports";

export interface ClaimedJob {
  id: string;
  versionId: string;
  requestedBy: string | null;
  attempts: number;
  maxAttempts: number;
}

interface JobRow {
  id: string | null;
  book_version_id: string;
  requested_by: string | null;
  attempts: number;
  max_attempts: number;
}

/** Thin typed wrapper over the SQL queue functions (service-role / owner connection only). */
export function createQueueClient(db: Queryable, workerId: string, leaseSeconds: number) {
  return {
    async claim(): Promise<ClaimedJob | null> {
      const r = await db.query<JobRow>("select * from claim_ingestion_job($1, $2)", [workerId, leaseSeconds]);
      const row = r.rows[0];
      if (!row?.id) return null;
      return { id: row.id, versionId: row.book_version_id, requestedBy: row.requested_by, attempts: row.attempts, maxAttempts: row.max_attempts };
    },
    contextFor(job: ClaimedJob): JobContext {
      return {
        jobId: job.id,
        versionId: job.versionId,
        requestedBy: job.requestedBy,
        async checkpoint(stage: Stage, progress?: Record<string, unknown>) {
          const r = await db.query<{ ok: boolean }>("select heartbeat_ingestion_job($1,$2,$3,$4,$5::jsonb) as ok", [
            job.id,
            workerId,
            leaseSeconds,
            stage,
            JSON.stringify(progress ?? {}),
          ]);
          if (!r.rows[0]?.ok) throw new LeaseLostError();
        },
      };
    },
    async complete(job: ClaimedJob): Promise<boolean> {
      const r = await db.query<{ ok: boolean }>("select complete_ingestion_job($1,$2) as ok", [job.id, workerId]);
      return !!r.rows[0]?.ok;
    },
    async fail(job: ClaimedJob, error: string, retryable: boolean): Promise<string | null> {
      const r = await db.query<{ s: string | null }>("select fail_ingestion_job($1,$2,$3,$4) as s", [job.id, workerId, error, retryable]);
      return r.rows[0]?.s ?? null;
    },
  };
}
export type QueueClient = ReturnType<typeof createQueueClient>;
