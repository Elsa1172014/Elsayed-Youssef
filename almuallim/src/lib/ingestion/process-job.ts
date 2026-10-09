import type { Logger } from "@/lib/logger";
import { runIngestion, type IngestionPorts } from "./pipeline";
import { LeaseLostError, NonRetryableError } from "./ports";
import type { ClaimedJob, QueueClient } from "./queue";

export type JobOutcome = "succeeded" | "retry" | "failed" | "lease_lost";

/** Run one claimed job and translate the result into queue state. Never throws. */
export async function processJob(job: ClaimedJob, queue: QueueClient, ports: IngestionPorts, log: Logger): Promise<JobOutcome> {
  const jl = log.child({ jobId: job.id, versionId: job.versionId, attempt: job.attempts });
  const started = Date.now();
  try {
    jl.info("job started");
    await runIngestion(queue.contextFor(job), { ...ports, log: jl });
    const ok = await queue.complete(job);
    jl.info("job finished", { ok, ms: Date.now() - started });
    return ok ? "succeeded" : "lease_lost";
  } catch (e) {
    if (e instanceof LeaseLostError) {
      jl.warn("lease lost; abandoning job to the new owner");
      return "lease_lost";
    }
    const retryable = !(e instanceof NonRetryableError);
    const msg = e instanceof Error ? e.message : String(e);
    const state = await queue.fail(job, msg, retryable).catch(() => null);
    jl.error("job failed", { error: msg, retryable, state, ms: Date.now() - started });
    return state === "queued" ? "retry" : "failed";
  }
}
