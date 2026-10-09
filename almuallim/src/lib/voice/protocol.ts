/**
 * Normalisation of OpenAI Realtime (GA) events. Event names and shapes were checked against the AI SDK's
 * OpenAI realtime adapter source (node_modules/@ai-sdk/openai). Unknown events map to `{type:"other"}` so new
 * server events can never crash the client.
 */
export type ServerEvent =
  | { type: "session-created" | "session-updated" }
  | { type: "speech-started" | "speech-stopped"; itemId?: string }
  | { type: "input-transcription"; itemId: string; transcript: string }
  | { type: "response-created"; responseId?: string }
  | { type: "response-done"; responseId?: string; status: string }
  | { type: "audio-transcript-delta"; itemId: string; responseId?: string; delta: string }
  | { type: "audio-transcript-done"; itemId: string; responseId?: string; transcript: string }
  | { type: "tool-call"; callId: string; name: string; arguments: string }
  | { type: "error"; code?: string; message: string }
  | { type: "other"; rawType: string };

interface Raw {
  type?: string; item_id?: string; response_id?: string; response?: { id?: string; status?: string }; transcript?: string;
  delta?: string; call_id?: string; name?: string; arguments?: string; error?: { code?: string; message?: string }; code?: string; message?: string;
}

export function parseServerEvent(raw: unknown): ServerEvent {
  const e = (raw && typeof raw === "object" ? raw : {}) as Raw;
  switch (e.type) {
    case "session.created": return { type: "session-created" };
    case "session.updated": return { type: "session-updated" };
    case "input_audio_buffer.speech_started": return { type: "speech-started", itemId: e.item_id };
    case "input_audio_buffer.speech_stopped": return { type: "speech-stopped", itemId: e.item_id };
    case "conversation.item.input_audio_transcription.completed": return { type: "input-transcription", itemId: e.item_id ?? "", transcript: e.transcript ?? "" };
    case "response.created": return { type: "response-created", responseId: e.response?.id ?? e.response_id };
    case "response.done": return { type: "response-done", responseId: e.response?.id ?? e.response_id, status: e.response?.status ?? "completed" };
    case "response.output_audio_transcript.delta": return { type: "audio-transcript-delta", itemId: e.item_id ?? "", responseId: e.response_id, delta: e.delta ?? "" };
    case "response.output_audio_transcript.done": return { type: "audio-transcript-done", itemId: e.item_id ?? "", responseId: e.response_id, transcript: e.transcript ?? "" };
    case "response.function_call_arguments.done": return { type: "tool-call", callId: e.call_id ?? "", name: e.name ?? "", arguments: e.arguments ?? "{}" };
    case "error": return { type: "error", code: e.error?.code ?? e.code, message: e.error?.message ?? e.message ?? "unknown error" };
    default: return { type: "other", rawType: String(e.type ?? "unknown") };
  }
}

export const clientEvents = {
  text(role: "user" | "system", text: string) {
    return { type: "conversation.item.create", item: { type: "message", role, content: [{ type: "input_text", text }] } };
  },
  toolOutput(callId: string, output: string) {
    return { type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } };
  },
  respond(instructions?: string) {
    return instructions ? { type: "response.create", response: { instructions } } : { type: "response.create" };
  },
  cancel() {
    return { type: "response.cancel" };
  },
  truncate(itemId: string, audioEndMs: number) {
    return { type: "conversation.item.truncate", item_id: itemId, content_index: 0, audio_end_ms: Math.max(0, Math.round(audioEndMs)) };
  },
} as const;

/** Errors that are expected during normal barge-in/teardown races and must not disturb the session. */
const BENIGN_CODES = new Set(["response_cancel_not_active", "item_truncate_invalid_item_id", "item_truncate_invalid_audio_end_ms", "conversation_already_has_active_response", "invalid_value"]);
const FATAL_CODES = new Set(["invalid_api_key", "session_expired", "token_expired", "authentication_error", "insufficient_quota", "rate_limit_exceeded"]);

export function classifyProviderError(code: string | undefined, message: string): "benign" | "fatal" | "warning" {
  if (code && BENIGN_CODES.has(code)) return "benign";
  if (/no active response|cancel.*not.*active|truncat/i.test(message)) return "benign";
  if (code && FATAL_CODES.has(code)) return "fatal";
  return "warning";
}
