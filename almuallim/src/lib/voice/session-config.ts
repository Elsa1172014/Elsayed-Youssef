import { z } from "zod";
import { evidenceInput, pageInput, searchInput } from "@/lib/tutor/tool-core";

export interface RealtimeToolDef {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const schemaOf = (s: z.ZodType) => {
  const { $schema: _omit, ...rest } = z.toJSONSchema(s, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  return rest;
};

/** Same tools the text tutor has, described for the realtime API. Execution always happens server-side. */
export function realtimeToolDefinitions(): RealtimeToolDef[] {
  return [
    { type: "function", name: "search_textbook", description: "Search the student's textbook. Call before explaining any curriculum content; returns passages with chunkId and page numbers.", parameters: schemaOf(searchInput) },
    { type: "function", name: "get_page", description: "Read the full text of one textbook page by physical page number (e.g. the confirmed page).", parameters: schemaOf(pageInput) },
    { type: "function", name: "get_lesson_outline", description: "List the lessons of the current textbook with page ranges.", parameters: schemaOf(z.object({})) },
    { type: "function", name: "record_evidence", description: "Record evidence about the student's answer for one skill (practice/assessment). Never tell the student a grade.", parameters: schemaOf(evidenceInput) },
  ];
}

export interface RealtimeSessionOptions {
  model: string;
  voice: string;
  transcribeModel: string;
  instructions: string;
}

/**
 * Session body for `POST /v1/realtime/client_secrets`. Field names follow the shape used by the AI SDK's
 * OpenAI realtime adapter (verified in node_modules/@ai-sdk/openai); no undocumented fields are sent.
 *
 * Turn detection uses server VAD with a raised threshold and longer silence window, which is more
 * robust in noisy classrooms than the defaults; the server auto-interrupts the model when the student speaks.
 */
export function buildRealtimeSession(o: RealtimeSessionOptions) {
  return {
    type: "realtime",
    model: o.model,
    instructions: o.instructions,
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: { model: o.transcribeModel, language: "ar" },
        turn_detection: { type: "server_vad", threshold: 0.6, silence_duration_ms: 700, prefix_padding_ms: 300 },
      },
      output: { voice: o.voice },
    },
    tools: realtimeToolDefinitions(),
    tool_choice: "auto",
  };
}

export class RealtimeProviderError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "RealtimeProviderError";
  }
}

/** Mint a short-lived client secret. The permanent API key never leaves the server. */
export async function mintClientSecret(opts: {
  apiKey: string;
  session: object;
  ttlSeconds?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ value: string; expiresAt: number | null }> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl ?? "https://api.openai.com/v1"}/realtime/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session: opts.session, expires_after: { anchor: "created_at", seconds: opts.ttlSeconds ?? 120 } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new RealtimeProviderError(`client_secrets failed with HTTP ${res.status}`, res.status);
  const data = (await res.json()) as { value?: string; expires_at?: number };
  if (!data.value) throw new RealtimeProviderError("client_secrets returned no value", 502);
  return { value: data.value, expiresAt: data.expires_at ?? null };
}
