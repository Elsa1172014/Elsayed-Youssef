import { z } from "zod";

const num = (def: number) => z.coerce.number().int().positive().default(def);

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
});

const serverSchema = publicSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  OPENAI_API_KEY: z.string().min(10),
  TUTOR_MODEL: z.string().default("gpt-5-mini"),
  VISION_MODEL: z.string().default("gpt-5-mini"),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  REALTIME_MODEL: z.string().default("gpt-realtime"),
  REALTIME_VOICE: z.string().default("marin"),
  REALTIME_TRANSCRIBE_MODEL: z.string().default("gpt-4o-mini-transcribe"),
  RATE_LIMIT_CHAT_PER_MIN: num(20),
  RATE_LIMIT_VISION_PER_MIN: num(6),
  RATE_LIMIT_REALTIME_TOKEN_PER_HOUR: num(10),
  BUDGET_TUTOR_TOKENS_PER_USER_DAY: num(200_000),
  BUDGET_VISION_CALLS_PER_USER_DAY: num(200),
  BUDGET_REALTIME_SECONDS_PER_USER_DAY: num(3600),
  BUDGET_GLOBAL_TUTOR_TOKENS_PER_DAY: num(5_000_000),
});

const workerSchema = z.object({
  DATABASE_URL: z.string().min(10),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  OPENAI_API_KEY: z.string().min(10),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  VISION_MODEL: z.string().default("gpt-5-mini"),
  INGEST_WORKER_ID: z.string().default(`worker-${process.pid}`),
  INGEST_LEASE_SECONDS: num(120),
  INGEST_POLL_MS: num(3000),
  INGEST_OCR: z.enum(["0", "1"]).default("0"),
  PAGE_IMAGE_DPI: num(110),
});

export type PublicEnv = z.infer<typeof publicSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;
export type WorkerEnv = z.infer<typeof workerSchema>;

export class EnvError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing or invalid environment variables: ${missing.join(", ")}. See .env.example.`);
    this.name = "EnvError";
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, source: Record<string, string | undefined>): z.infer<T> {
  const r = schema.safeParse(source);
  if (!r.success) throw new EnvError([...new Set(r.error.issues.map((i) => String(i.path[0] ?? "?")))]);
  return r.data;
}

// NOTE: Next.js inlines NEXT_PUBLIC_* only for *static* property access, hence the explicit mapping.
export function publicEnv(): PublicEnv {
  return parse(publicSchema, {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
}

let serverCache: ServerEnv | undefined;
export function serverEnv(): ServerEnv {
  return (serverCache ??= parse(serverSchema, process.env));
}

export function workerEnv(source: Record<string, string | undefined> = process.env): WorkerEnv {
  return parse(workerSchema, source);
}
