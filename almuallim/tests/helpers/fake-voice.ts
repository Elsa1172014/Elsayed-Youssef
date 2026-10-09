import { vi } from "vitest";
import type { ReportEvent, RealtimeTransport, VoiceApi } from "@/lib/voice/client";
import { VoiceApiError, type VoiceErrorCode } from "@/lib/voice/client";

/** Scriptable transport double. TEST-ONLY. */
export class FakeTransport implements RealtimeTransport {
  sent: Record<string, unknown>[] = [];
  micEnabled = true;
  outputStops = 0;
  outputResumes = 0;
  closes = 0;
  releases = 0;
  connects = 0;
  open = false;
  micError: unknown = null;
  connectError: unknown = null;
  hangConnect = false;
  lastConnect: { clientSecret: string; callsUrl: string } | null = null;
  onMessage: ((e: unknown) => void) | null = null;
  onClose: ((r: string) => void) | null = null;

  async acquireMic() { if (this.micError) throw this.micError; }
  async connect(o: { clientSecret: string; callsUrl: string }) {
    this.connects++;
    this.lastConnect = o;
    if (this.hangConnect) await new Promise(() => undefined);
    if (this.connectError) throw this.connectError;
    this.open = true;
  }
  isOpen() { return this.open; }
  send(e: object) { this.sent.push(e as Record<string, unknown>); }
  setMicEnabled(b: boolean) { this.micEnabled = b; }
  stopOutputAudio() { this.outputStops++; }
  resumeOutputAudio() { this.outputResumes++; }
  close() { this.closes++; this.open = false; }
  release() { this.releases++; this.open = false; }

  emit(raw: unknown) { this.onMessage?.(raw); }
  drop(reason = "disconnected") { this.open = false; this.onClose?.(reason); }
  types() { return this.sent.map((e) => e.type as string); }
  find(type: string) { return this.sent.filter((e) => e.type === type); }
}

export class FakeApi implements VoiceApi {
  tokenQueue: (() => Promise<{ clientSecret: string; callsUrl: string }>)[] = [];
  tokens = 0;
  reported: ReportEvent[] = [];
  toolHandler: (c: { name: string; arguments: string; callId: string }) => Promise<{ output: string }> = async () => ({ output: '{"ok":true}' });
  toolCalls: { name: string; arguments: string; callId: string }[] = [];

  async fetchToken() {
    this.tokens++;
    const next = this.tokenQueue.shift();
    return next ? next() : { clientSecret: `ek_${this.tokens}`, callsUrl: "https://example.test/calls" };
  }
  failNextToken(code: VoiceErrorCode) { this.tokenQueue.push(async () => { throw new VoiceApiError(code); }); }
  async runTool(c: { name: string; arguments: string; callId: string }) { this.toolCalls.push(c); return this.toolHandler(c); }
  async reportEvents(e: ReportEvent[]) { this.reported.push(...e); }
}

export const ev = {
  speechStarted: () => ({ type: "input_audio_buffer.speech_started", item_id: "u1" }),
  speechStopped: () => ({ type: "input_audio_buffer.speech_stopped", item_id: "u1" }),
  userTranscript: (t: string, id = "u1") => ({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: t }),
  responseCreated: () => ({ type: "response.created", response: { id: "r1" } }),
  responseDone: (status = "completed") => ({ type: "response.done", response: { id: "r1", status } }),
  delta: (d: string, id = "a1") => ({ type: "response.output_audio_transcript.delta", item_id: id, response_id: "r1", delta: d }),
  done: (t: string, id = "a1") => ({ type: "response.output_audio_transcript.done", item_id: id, response_id: "r1", transcript: t }),
  toolCall: (name: string, args: unknown, callId = "call1") => ({ type: "response.function_call_arguments.done", call_id: callId, name, arguments: JSON.stringify(args) }),
  error: (code: string, message = "boom") => ({ type: "error", error: { code, message } }),
};

export const flush = () => vi.advanceTimersByTimeAsync(0);
