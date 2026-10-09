import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeVoiceClient, type VoiceClientOptions } from "@/lib/voice/client";
import { classifyProviderError, parseServerEvent } from "@/lib/voice/protocol";
import { FakeApi, FakeTransport, ev, flush } from "../helpers/fake-voice";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function make(opts: VoiceClientOptions = {}) {
  const t = new FakeTransport();
  const api = new FakeApi();
  const c = new RealtimeVoiceClient(t, api, opts);
  const phases: string[] = [];
  c.subscribe((s) => { if (phases.at(-1) !== s.phase) phases.push(s.phase); });
  return { t, api, c, phases };
}
async function live(opts: VoiceClientOptions = {}) {
  const x = make(opts);
  await x.c.start();
  return x;
}

describe("start / stop", () => {
  it("walks requesting-mic → fetching-token → connecting → live and greets the student", async () => {
    const { c, t, phases } = make();
    await c.start();
    expect(phases).toEqual(["requesting-mic", "fetching-token", "connecting", "live"]);
    expect(c.getState()).toMatchObject({ phase: "live", activity: "listening", muted: false, error: null });
    expect(t.lastConnect).toEqual({ clientSecret: "ek_1", callsUrl: "https://example.test/calls" });
    expect(t.find("response.create")).toHaveLength(1); // greeting
  });

  it("stop() closes the transport, reports 'ended' once and never reconnects", async () => {
    const { c, t, api } = await live();
    await c.stop();
    expect(c.getState().phase).toBe("ended");
    expect(t.releases).toBe(1); // microphone released
    t.drop(); // late close event from the closed transport
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.connects).toBe(1);
    expect(api.reported.filter((e) => e.type === "state" && e.voice === "ended")).toHaveLength(1);
    await c.stop(); // idempotent
    expect(api.reported.filter((e) => e.type === "state" && e.voice === "ended")).toHaveLength(1);
  });

  it("can be started again after ending", async () => {
    const { c, t } = await live();
    await c.stop();
    await c.start();
    expect(c.getState().phase).toBe("live");
    expect(t.connects).toBe(2);
  });
  it("releases the microphone on every terminal path (stop, error)", async () => {
    const a = await live();
    await a.c.stop();
    expect(a.t.releases).toBe(1);
    const b = make();
    b.t.connectError = new Error("x");
    await b.c.start();
    expect(b.t.releases).toBeGreaterThan(0);
  });
});

describe("permission and startup errors", () => {
  it.each([
    ["NotAllowedError", "mic-denied"], ["NotFoundError", "mic-missing"], ["NotReadableError", "mic-busy"], ["SecurityError", "insecure"],
  ])("microphone %s → %s, without ever requesting a token", async (name, code) => {
    const { c, t, api } = make();
    t.micError = Object.assign(new Error(name), { name });
    await c.start();
    expect(c.getState()).toMatchObject({ phase: "error", error: { code } });
    expect(api.tokens).toBe(0);
  });

  it.each(["rate-limited", "budget", "not-configured", "token-failed"] as const)("token endpoint failure %s is surfaced as that error", async (code) => {
    const { c, api, t } = make();
    api.failNextToken(code);
    await c.start();
    expect(c.getState()).toMatchObject({ phase: "error", error: { code } });
    expect(t.connects).toBe(0);
  });

  it("times out a hanging connection and closes it", async () => {
    const { c, t } = make({ connectTimeoutMs: 5000 });
    t.hangConnect = true;
    const p = c.start();
    await vi.advanceTimersByTimeAsync(5001);
    await p;
    expect(c.getState()).toMatchObject({ phase: "error", error: { code: "connect-failed" } });
    expect(t.closes).toBeGreaterThan(0);
  });

  it("a connection error becomes connect-failed", async () => {
    const { c, t } = make();
    t.connectError = new Error("ice failed");
    await c.start();
    expect(c.getState().error?.code).toBe("connect-failed");
  });
});

describe("transcripts", () => {
  it("builds user and streaming assistant transcripts and persists final turns once", async () => {
    const { c, t, api } = await live();
    t.emit(ev.speechStarted());
    expect(c.getState().activity).toBe("user-speaking");
    t.emit(ev.speechStopped());
    t.emit(ev.userTranscript("  ما هو الفاعل؟ "));
    t.emit(ev.responseCreated());
    t.emit(ev.delta("الفاعل "));
    t.emit(ev.delta("اسم مرفوع"));
    expect(c.getState().activity).toBe("model-speaking");
    expect(c.getState().transcript.at(-1)).toMatchObject({ role: "assistant", text: "الفاعل اسم مرفوع", final: false });
    t.emit(ev.done("الفاعل اسم مرفوع."));
    t.emit(ev.responseDone());
    const tr = c.getState().transcript;
    expect(tr.map((x) => [x.role, x.text, x.final])).toEqual([["user", "ما هو الفاعل؟", true], ["assistant", "الفاعل اسم مرفوع.", true]]);
    expect(c.getState().activity).toBe("listening");
    t.emit(ev.done("الفاعل اسم مرفوع.")); // duplicate done must not double-report
    expect(api.reported.filter((e) => e.type === "assistant_speech")).toHaveLength(1);
    expect(api.reported.filter((e) => e.type === "user_speech")).toEqual([{ type: "user_speech", text: "ما هو الفاعل؟" }]);
  });

  it("ignores empty transcriptions (silence/noise) and unknown events", async () => {
    const { c, t } = await live();
    t.emit(ev.userTranscript("   "));
    t.emit({ type: "some.future.event", x: 1 });
    t.emit(null);
    t.emit("garbage");
    expect(c.getState().transcript).toHaveLength(0);
    expect(c.getState().phase).toBe("live");
  });
});

describe("barge-in", () => {
  it("student speech while the model is talking stops playback, cancels the response and truncates at the heard position", async () => {
    const { c, t, api } = await live();
    t.emit(ev.responseCreated());
    t.emit(ev.delta("الفاعل اسم", "item-9"));
    await vi.advanceTimersByTimeAsync(1500);
    t.emit(ev.speechStarted());
    expect(t.outputStops).toBe(1);
    expect(t.find("response.cancel")).toHaveLength(1);
    const trunc = t.find("conversation.item.truncate")[0]!;
    expect(trunc).toMatchObject({ item_id: "item-9", content_index: 0 });
    expect(trunc.audio_end_ms as number).toBeGreaterThanOrEqual(1400);
    const last = c.getState().transcript.at(-1)!;
    expect(last).toMatchObject({ final: true, interrupted: true });
    expect(c.getState().activity).toBe("user-speaking");
    expect(api.reported).toContainEqual({ type: "assistant_speech", text: "الفاعل اسم", interrupted: true });
    // next response resumes local playback
    t.emit(ev.responseCreated());
    expect(t.outputResumes).toBeGreaterThan(0);
  });

  it("student speech when the model is silent does not cancel anything", async () => {
    const { t } = await live();
    t.emit(ev.speechStarted());
    expect(t.find("response.cancel")).toHaveLength(0);
  });

  it("the interrupt button behaves like barge-in", async () => {
    const { c, t } = await live();
    t.emit(ev.delta("نص طويل", "i1"));
    c.interrupt();
    expect(t.outputStops).toBe(1);
    expect(t.find("response.cancel")).toHaveLength(1);
    expect(c.getState().activity).toBe("listening");
  });
});

describe("tool calls", () => {
  it("runs the tool server-side, returns its output to the model, then asks for a response", async () => {
    const { t, api, c } = await live();
    api.toolHandler = async () => ({ output: JSON.stringify({ passages: [{ chunkId: "c1" }] }) });
    t.sent.length = 0;
    t.emit(ev.toolCall("search_textbook", { query: "الفاعل" }, "call-7"));
    expect(c.getState().activity).toBe("thinking");
    await flush();
    expect(api.toolCalls).toEqual([{ name: "search_textbook", arguments: '{"query":"الفاعل"}', callId: "call-7" }]);
    expect(t.sent[0]).toMatchObject({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "call-7" } });
    expect(t.sent[1]).toMatchObject({ type: "response.create" });
  });

  it("parallel tool calls produce one response after the last result", async () => {
    const { t, api } = await live();
    t.sent.length = 0;
    t.emit(ev.toolCall("search_textbook", { query: "أ" }, "a"));
    t.emit(ev.toolCall("get_page", { pageNumber: 2 }, "b"));
    await flush();
    expect(api.toolCalls).toHaveLength(2);
    expect(t.find("conversation.item.create")).toHaveLength(2);
    expect(t.find("response.create")).toHaveLength(1);
  });

  it("a failing or hanging tool yields an explicit error output so the model never stalls or guesses", async () => {
    const { t, api } = await live({ toolTimeoutMs: 1000 });
    api.toolHandler = () => new Promise(() => undefined); // never resolves
    t.sent.length = 0;
    t.emit(ev.toolCall("search_textbook", { query: "x" }, "slow"));
    await vi.advanceTimersByTimeAsync(1001);
    const out = (t.sent[0]!.item as { output: string }).output;
    expect(JSON.parse(out).error).toBe("tool_unavailable");
    expect(t.find("response.create")).toHaveLength(1);
  });
});

describe("mute, text and context", () => {
  it("mute disables the microphone track and is reported", async () => {
    const { c, t, api } = await live();
    c.setMuted(true);
    expect(t.micEnabled).toBe(false);
    expect(c.getState().muted).toBe(true);
    c.setMuted(false);
    expect(t.micEnabled).toBe(true);
    expect(api.reported.filter((e) => e.type === "state").map((e) => (e as { voice: string }).voice)).toEqual(["muted", "unmuted"]);
  });

  it("typed text in a voice session is sent as a user message", async () => {
    const { c, t } = await live();
    t.sent.length = 0;
    c.sendText("  اشرح الدرس  ");
    expect(t.sent[0]).toMatchObject({ type: "conversation.item.create", item: { role: "user", content: [{ type: "input_text", text: "اشرح الدرس" }] } });
    expect(t.sent[1]).toMatchObject({ type: "response.create" });
    expect(c.getState().transcript.at(-1)).toMatchObject({ role: "user", text: "اشرح الدرس" });
  });

  it("pushContext injects a system message and triggers speech WITHOUT reconnecting", async () => {
    const { c, t } = await live();
    t.sent.length = 0;
    expect(c.pushContext("تحديث سياق: الصفحة 4")).toBe(true);
    expect(t.sent[0]).toMatchObject({ item: { role: "system", content: [{ type: "input_text", text: "تحديث سياق: الصفحة 4" }] } });
    expect(t.sent[1]).toMatchObject({ type: "response.create" });
    expect(t.connects).toBe(1);
    expect(t.closes).toBe(0);
  });

  it("pushContext interrupts the model if it is mid-sentence, and is ignored when not live", async () => {
    const { c, t } = await live();
    t.emit(ev.delta("جملة طويلة", "x"));
    c.pushContext("سياق");
    expect(t.find("response.cancel")).toHaveLength(1);
    await c.stop();
    expect(c.pushContext("سياق آخر")).toBe(false);
  });
});

describe("reconnect", () => {
  it("recovers from a dropped connection with backoff, keeps the transcript, and restores context", async () => {
    const { c, t, api } = await live({ getResumeContext: () => "سياق الصفحة 4" });
    t.emit(ev.userTranscript("ما الفاعل؟"));
    t.emit(ev.done("اسم مرفوع", "a1"));
    t.sent.length = 0;
    t.drop();
    expect(c.getState()).toMatchObject({ phase: "reconnecting", reconnectAttempt: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(c.getState().phase).toBe("live");
    expect(t.connects).toBe(2);
    expect(api.tokens).toBe(2); // fresh short-lived token each time
    const note = (t.sent[0]!.item as { content: { text: string }[] }).content[0]!.text;
    expect(note).toContain("انقطع الاتصال");
    expect(note).toContain("ما الفاعل؟");
    expect(note).toContain("سياق الصفحة 4");
    expect(c.getState().transcript.length).toBeGreaterThanOrEqual(2);
    expect(api.reported.map((e) => (e.type === "state" ? e.voice : e.type))).toEqual(expect.arrayContaining(["reconnecting", "reconnected"]));
  });

  it("gives up after the maximum attempts with 'connection-lost' and exponential backoff", async () => {
    const { c, t } = await live({ maxReconnects: 3 });
    t.connectError = new Error("offline");
    t.drop();
    await vi.advanceTimersByTimeAsync(999);
    expect(t.connects).toBe(1); // backoff 1s not elapsed yet
    await vi.advanceTimersByTimeAsync(1); // attempt 1 fires and fails
    expect(t.connects).toBe(2);
    await vi.advanceTimersByTimeAsync(2000); // attempt 2 after 2s backoff
    expect(t.connects).toBe(3);
    await vi.advanceTimersByTimeAsync(4000); // attempt 3 after 4s backoff
    await flush();
    expect(c.getState()).toMatchObject({ phase: "error", error: { code: "connection-lost" } });
    expect(t.connects).toBe(1 + 3);
  });

  it("stops reconnecting immediately when the budget is exhausted", async () => {
    const { c, t, api } = await live();
    api.failNextToken("budget");
    t.drop();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(c.getState()).toMatchObject({ phase: "error", error: { code: "budget" } });
    expect(t.connects).toBe(1);
  });

  it("waits for the network to come back before retrying", async () => {
    let online = false;
    const h: { fire?: () => void } = {};
    const { c, t } = await live({ isOnline: () => online, onceOnline: (cb) => ((h.fire = cb), () => { h.fire = undefined; }) });
    t.drop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.connects).toBe(1); // still offline: no attempt yet
    online = true;
    h.fire?.();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(c.getState().phase).toBe("live");
  });

  it("a stale connection discovered when the tab becomes visible triggers a reconnect", async () => {
    const { c, t } = await live();
    t.open = false; // OS suspended the socket while backgrounded; no close event was delivered
    c.handleVisibility(true);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(t.connects).toBe(2);
    expect(c.getState().phase).toBe("live");
  });
});

describe("cost and safety limits", () => {
  it("ends the session after inactivity", async () => {
    const { c, t } = await live({ idleTimeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(c.getState()).toMatchObject({ phase: "ended", error: { code: "idle-timeout" } });
    expect(t.releases).toBe(1);
  });
  it("activity resets the inactivity timer", async () => {
    const { c, t } = await live({ idleTimeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(50_000);
    t.emit(ev.speechStarted());
    await vi.advanceTimersByTimeAsync(50_000);
    expect(c.getState().phase).toBe("live");
  });
  it("enforces a maximum session duration", async () => {
    const { c } = await live({ maxSessionMs: 120_000, idleTimeoutMs: 10 * 60_000 });
    await vi.advanceTimersByTimeAsync(120_001);
    expect(c.getState()).toMatchObject({ phase: "ended", error: { code: "max-duration" } });
  });
});

describe("provider errors", () => {
  it("benign race errors do not disturb the session", async () => {
    const { c, t } = await live();
    t.emit(ev.error("response_cancel_not_active", "Cancellation failed: no active response found"));
    t.emit(ev.error("item_truncate_invalid_item_id", "x"));
    expect(c.getState()).toMatchObject({ phase: "live", warning: null });
  });
  it("other errors become a visible warning but keep the call alive", async () => {
    const { c, t } = await live();
    t.emit(ev.error("server_error", "temporary glitch"));
    expect(c.getState()).toMatchObject({ phase: "live", warning: "temporary glitch" });
  });
  it("authentication/quota errors end the call with provider-error", async () => {
    const { c, t } = await live();
    t.emit(ev.error("invalid_api_key", "bad key"));
    expect(c.getState()).toMatchObject({ phase: "error", error: { code: "provider-error" } });
    expect(t.releases).toBeGreaterThan(0);
  });
});

describe("protocol parsing", () => {
  it("maps GA event names and survives malformed input", () => {
    expect(parseServerEvent({ type: "response.output_audio_transcript.delta", item_id: "i", delta: "x" })).toMatchObject({ type: "audio-transcript-delta", itemId: "i", delta: "x" });
    expect(parseServerEvent({ type: "response.function_call_arguments.done", call_id: "c", name: "n", arguments: "{}" })).toEqual({ type: "tool-call", callId: "c", name: "n", arguments: "{}" });
    expect(parseServerEvent(undefined)).toEqual({ type: "other", rawType: "unknown" });
    expect(classifyProviderError("x", "Cancellation failed: no active response")).toBe("benign");
    expect(classifyProviderError("session_expired", "x")).toBe("fatal");
    expect(classifyProviderError("weird", "x")).toBe("warning");
  });
});
