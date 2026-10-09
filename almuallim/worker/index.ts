/**
 * Durable ingestion worker. Runs as its own long-lived process (see worker/Dockerfile), NOT inside Vercel.
 * Claims jobs from PostgreSQL (FOR UPDATE SKIP LOCKED + leases), so any number of replicas are safe and a
 * crashed replica's job is picked up by another once its lease expires.
 *
 *   npm run worker          # poll forever
 *   npm run worker:once     # drain the queue then exit (CI / cron-style hosts)
 */
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { workerEnv } from "../src/lib/env";
import { createLogger } from "../src/lib/logger";
import { createSupabasePdfSource, createPopplerPageImages, createVisionOcr } from "../src/lib/ingestion/adapters";
import { createPgIngestionStore } from "../src/lib/ingestion/pg-store";
import { processJob } from "../src/lib/ingestion/process-job";
import { createQueueClient } from "../src/lib/ingestion/queue";
import { createOpenAIEmbeddings } from "../src/lib/providers/embeddings";
import { createOpenAIRecognizer } from "../src/lib/providers/vision";

const log = createLogger({ app: "almuallim-worker" });
const once = process.argv.includes("--once");
const env = workerEnv();

const pool = new Pool({ connectionString: env.DATABASE_URL, max: 4 });
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const images = createPopplerPageImages(supabase, env.PAGE_IMAGE_DPI);
const ports = {
  store: createPgIngestionStore(pool),
  pdf: createSupabasePdfSource(supabase),
  embeddings: createOpenAIEmbeddings({ apiKey: env.OPENAI_API_KEY, model: env.EMBEDDING_MODEL }),
  images,
  ocr: env.INGEST_OCR === "1" ? createVisionOcr(createOpenAIRecognizer({ apiKey: env.OPENAI_API_KEY, model: env.VISION_MODEL })) : undefined,
  log,
};
const queue = createQueueClient(pool, env.INGEST_WORKER_ID, env.INGEST_LEASE_SECONDS);

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("shutdown requested; finishing current job", { sig });
    stopping = true;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log.info("worker started", { workerId: env.INGEST_WORKER_ID, ocr: env.INGEST_OCR === "1", once });
  while (!stopping) {
    let job;
    try {
      job = await queue.claim();
    } catch (e) {
      log.error("claim failed (database unreachable?)", { error: e instanceof Error ? e.message : String(e) });
      await sleep(Math.min(30_000, env.INGEST_POLL_MS * 5));
      continue;
    }
    if (!job) {
      if (once) break;
      await sleep(env.INGEST_POLL_MS);
      continue;
    }
    await processJob(job, queue, ports, log);
    await images.dispose();
  }
  await pool.end();
  log.info("worker stopped");
}

main().catch((e) => {
  log.error("worker crashed", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
