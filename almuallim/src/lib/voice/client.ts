import { classifyProviderError, clientEvents, parseServerEvent, type ServerEvent } from "./protocol";

export type VoicePhase = "idle" | "requesting-mic" | "fetching-token" | "connecting" | "live" | "reconnecting" | "ended" | "error";
export type Activity = "listening" | "user-speaking" | "thinking" | "model-speaking";
export type VoiceErrorCode =
  | "mic-denied" | "mic-missing" | "mic-busy" | "insecure" | "unsupported"
  | "token-failed" | "rate-limited" | "budget" | "not-configured"
  | "connect-failed" | "connection-lost" | "provider-error" | "idle-timeout" | "max-duration";

export const VOICE_ERROR_MESSAGE_AR: Record<VoiceErrorCode, string> = {
  "mic-denied": "تم رفض إذن الميكروفون. فعّله من إعدادات المتصفح ثم أعد المحاولة، أو تابع بالكتابة.",
  "mic-missing": "لم يتم العثور على ميكروفون. وصّل سماعة بميكروفون أو تابع بالكتابة.",
  "mic-busy": "الميكروفون مستخدم في تطبيق آخر. أغلقه ثم أعد المحاولة.",
  insecure: "الميكروفون يعمل فقط عبر اتصال آمن (HTTPS).",
  unsupported: "هذا المتصفح لا يدعم المحادثة الصوتية. جرّب Chrome أو Safari حديثًا، أو تابع بالكتابة.",
  "token-failed": "تعذّر بدء المحادثة الصوتية الآن. تابع بالكتابة وحاول لاحقًا.",
  "rate-limited": "حاولت البدء مرات كثيرة. انتظر قليلًا ثم أعد المحاولة.",
  budget: "بلغتَ الحد اليومي للمحادثة الصوتية. تابع بالكتابة اليوم.",
  "not-configured": "المحادثة الصوتية غير مفعّلة بعد في هذه المنصة.",
  "connect-failed": "تعذّر الاتصال. تحقق من الشبكة وحاول مرة أخرى.",
  "connection-lost": "انقطع الاتصال ولم نتمكن من استعادته. تحقق من الشبكة ثم ابدأ من جديد.",
  "provider-error": "حدث خطأ في خدمة الصوت. حاول مرة أخرى.",
  "idle-timeout": "أُنهيت المحادثة الصوتية لعدم النشاط. اضغط للبدء من جديد.",
  "max-duration": "وصلت المحادثة الصوتية إلى المدة القصوى. ابدأ جلسة جديدة عند الحاجة.",
};

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  interrupted?: boolean;
}

export interface VoiceState {
  phase: VoicePhase;
  activity: Activity | null;
  muted: boolean;
  error: { code: VoiceErrorCode } | null;
  warning: string | null;
  reconnectAttempt: number;
  transcript: TranscriptEntry[];
}

export class VoiceApiError extends Error {
  constructor(public readonly code: VoiceErrorCode) {
    super(code);
    this.name = "VoiceApiError";
  }
}

export interface RealtimeTransport {
  /** Prompt for / acquire the microphone. Must throw the browser's DOMException on failure. */
  acquireMic(): Promise<void>;
  /** Open the provider connection with a short-lived secret; resolve once events can flow. */
  connect(opts: { clientSecret: string; callsUrl: string }): Promise<void>;
  isOpen(): boolean;
  send(event: object): void;
  setMicEnabled(enabled: boolean): void;
  /** Stop/resume local playback of the model's audio (instant barge-in; does not touch the server). */
  stopOutputAudio(): void;
  resumeOutputAudio(): void;
  /** Close the provider connection but keep the microphone (used between reconnect attempts). */
  close(): void;
  /** Close everything and release the microphone (the browser's recording indicator must turn off). */
  release(): void;
  onMessage: ((event: unknown) => void) | null;
  onClose: ((reason: string) => void) | null;
}

export interface VoiceApi {
  fetchToken(): Promise<{ clientSecret: string; callsUrl: string }>;
  runTool(call: { name: string; arguments: string; callId: string }): Promise<{ output: string }>;
  reportEvents(events: ReportEvent[]): Promise<void>;
}
export type ReportEvent =
  | { type: "user_speech"; text: string }
  | { type: "assistant_speech"; text: string; interrupted: boolean }
  | { type: "state"; voice: "ended" | "reconnecting" | "reconnected" | "muted" | "unmuted" }
  | { type: "error"; code: string };

export interface VoiceClientOptions {
  maxReconnects?: number;
  connectTimeoutMs?: number;
  toolTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxSessionMs?: number;
  greeting?: string | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  isOnline?: () => boolean;
  onceOnline?: (cb: () => void) => () => void;
  /** Called after a reconnect so the app can re-inject the confirmed page context. */
  getResumeContext?: () => string | null;
}

const initial = (): VoiceState => ({ phase: "idle", activity: null, muted: false, error: null, warning: null, reconnectAttempt: 0, transcript: [] });

function micErrorCode(e: unknown): VoiceErrorCode {
  switch ((e as { name?: string } | null)?.name) {
    case "NotAllowedError": case "PermissionDeniedError": return "mic-denied";
    case "NotFoundError": case "DevicesNotFoundError": return "mic-missing";
    case "NotReadableError": case "TrackStartError": case "AbortError": return "mic-busy";
    case "SecurityError": return "insecure";
    case "TypeError": return "unsupported";
    default: return "unsupported";
  }
}

/**
 * Voice session state machine. All I/O (microphone, WebRTC, HTTP, timers) is injected so every transition —
 * start/stop, mute, barge-in, tool calls, reconnect, timeouts, errors — is unit-tested without a browser.
 */
export class RealtimeVoiceClient {
  private state: VoiceState = initial();
  private listeners = new Set<(s: VoiceState) => void>();
  private userStopped = false;
  private pendingTools = 0;
  private modelSpeaking = false;
  private currentItem: { id: string; startedAt: number } | null = null;
  private reported = new Set<string>();
  private idleTimer: unknown = null;
  private maxTimer: unknown = null;
  private startedAt = 0;
  private reconnecting = false;
  private readonly o: Required<Omit<VoiceClientOptions, "getResumeContext" | "onceOnline" | "isOnline">> & Pick<VoiceClientOptions, "getResumeContext" | "onceOnline" | "isOnline">;

  constructor(private readonly transport: RealtimeTransport, private readonly api: VoiceApi, opts: VoiceClientOptions = {}) {
    this.o = {
      maxReconnects: 3, connectTimeoutMs: 15_000, toolTimeoutMs: 15_000, idleTimeoutMs: 5 * 60_000, maxSessionMs: 30 * 60_000,
      greeting: "رحّب بالطالب بجملة قصيرة وشجّعه على سؤالك أو على توجيه الكاميرا إلى صفحة الكتاب.",
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...opts,
    };
    transport.onMessage = (e) => this.onMessage(e);
    transport.onClose = (r) => void this.onClose(r);
  }

  getState = (): VoiceState => this.state;
  subscribe = (fn: (s: VoiceState) => void) => (this.listeners.add(fn), () => void this.listeners.delete(fn));

  private set(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }
  private report(e: ReportEvent) {
    void this.api.reportEvents([e]).catch(() => undefined); // best effort; never blocks audio
  }

  // ───────────────────────────── lifecycle ─────────────────────────────
  async start(): Promise<void> {
    if (!["idle", "ended", "error"].includes(this.state.phase)) return;
    this.userStopped = false;
    this.reported.clear();
    this.set({ ...initial(), phase: "requesting-mic", transcript: this.state.phase === "idle" ? [] : this.state.transcript });
    try {
      await this.transport.acquireMic();
    } catch (e) {
      return this.fail(micErrorCode(e));
    }
    if (this.userStopped) return;
    this.set({ phase: "fetching-token" });
    const r = await this.connectOnce(() => this.set({ phase: "connecting" }));
    if (this.userStopped) return;
    if (!r.ok) return this.fail(r.code);
    this.set({ phase: "live", activity: "listening", reconnectAttempt: 0 });
    this.startedAt = this.o.now();
    this.maxTimer = this.o.setTimer(() => void this.endWith("max-duration"), this.o.maxSessionMs);
    this.armIdle();
    if (this.o.greeting) this.transport.send(clientEvents.respond(this.o.greeting));
  }

  /** token → connect (with timeout). Side-effect free apart from `onToken`; callers decide how to react. */
  private async connectOnce(onToken?: () => void): Promise<{ ok: true } | { ok: false; code: VoiceErrorCode }> {
    let secret: { clientSecret: string; callsUrl: string };
    try {
      secret = await this.api.fetchToken();
    } catch (e) {
      return { ok: false, code: e instanceof VoiceApiError ? e.code : "token-failed" };
    }
    if (this.userStopped) return { ok: false, code: "connect-failed" };
    onToken?.();
    let timer: unknown;
    try {
      await Promise.race([
        this.transport.connect(secret),
        new Promise<never>((_, rej) => (timer = this.o.setTimer(() => rej(new Error("connect timeout")), this.o.connectTimeoutMs))),
      ]);
    } catch {
      this.transport.close();
      return { ok: false, code: "connect-failed" };
    } finally {
      this.o.clearTimer(timer);
    }
    return { ok: true };
  }

  private fail(code: VoiceErrorCode) {
    this.clearTimers();
    this.transport.release();
    this.set({ phase: "error", activity: null, error: { code } });
    this.report({ type: "error", code });
    this.report({ type: "state", voice: "ended" });
  }

  private async endWith(code: VoiceErrorCode) {
    this.userStopped = true;
    this.clearTimers();
    this.transport.release();
    this.set({ phase: "ended", activity: null, error: { code } });
    this.report({ type: "state", voice: "ended" });
  }

  async stop(): Promise<void> {
    if (this.state.phase === "ended" || this.state.phase === "idle") return;
    const wasError = this.state.phase === "error";
    this.userStopped = true;
    this.clearTimers();
    this.transport.release();
    this.finalizeStreaming(true);
    this.set({ phase: "ended", activity: null, error: wasError ? this.state.error : null });
    if (!wasError) this.report({ type: "state", voice: "ended" });
  }

  private clearTimers() {
    if (this.idleTimer) this.o.clearTimer(this.idleTimer);
    if (this.maxTimer) this.o.clearTimer(this.maxTimer);
    this.idleTimer = this.maxTimer = null;
  }
  private armIdle() {
    if (this.idleTimer) this.o.clearTimer(this.idleTimer);
    this.idleTimer = this.o.setTimer(() => void this.endWith("idle-timeout"), this.o.idleTimeoutMs);
  }

  // ───────────────────────────── controls ─────────────────────────────
  setMuted(muted: boolean) {
    if (this.state.phase !== "live" && this.state.phase !== "reconnecting") return;
    this.transport.setMicEnabled(!muted);
    this.set({ muted, activity: muted && this.state.activity === "user-speaking" ? "listening" : this.state.activity });
    this.report({ type: "state", voice: muted ? "muted" : "unmuted" });
  }

  /** Manual barge-in (button). */
  interrupt() {
    if (this.state.phase !== "live" || !this.modelSpeaking) return;
    this.bargeIn();
    this.set({ activity: "listening" });
  }

  sendText(text: string) {
    const t = text.trim();
    if (!t || this.state.phase !== "live") return;
    this.armIdle();
    if (this.modelSpeaking) this.bargeIn();
    this.addEntry({ id: `typed-${this.o.now()}`, role: "user", text: t, final: true });
    this.report({ type: "user_speech", text: t });
    this.transport.send(clientEvents.text("user", t));
    this.transport.send(clientEvents.respond());
    this.set({ activity: "thinking" });
  }

  /** Inject validated context (e.g. a newly confirmed page) into the live conversation without reconnecting. */
  pushContext(text: string, opts: { speak?: boolean } = {}) {
    if (this.state.phase !== "live") return false;
    this.armIdle();
    if (this.modelSpeaking) this.bargeIn();
    this.transport.send(clientEvents.text("system", text));
    if (opts.speak !== false) {
      this.transport.send(clientEvents.respond());
      this.set({ activity: "thinking" });
    }
    return true;
  }

  // ───────────────────────────── server events ─────────────────────────────
  private bargeIn() {
    this.transport.stopOutputAudio();
    this.transport.send(clientEvents.cancel());
    if (this.currentItem) {
      this.transport.send(clientEvents.truncate(this.currentItem.id, this.o.now() - this.currentItem.startedAt));
      this.finalizeStreaming(true);
    }
    this.modelSpeaking = false;
  }

  private onMessage(raw: unknown) {
    let e: ServerEvent;
    try {
      e = parseServerEvent(raw);
    } catch {
      return;
    }
    if (this.state.phase !== "live" && this.state.phase !== "reconnecting") return;
    switch (e.type) {
      case "speech-started":
        this.armIdle();
        if (this.modelSpeaking) this.bargeIn();
        if (!this.state.muted) this.set({ activity: "user-speaking" });
        break;
      case "speech-stopped":
        this.set({ activity: "thinking" });
        break;
      case "input-transcription": {
        const t = e.transcript.trim();
        if (!t) break;
        this.addEntry({ id: `u-${e.itemId}`, role: "user", text: t, final: true });
        this.report({ type: "user_speech", text: t });
        break;
      }
      case "response-created":
        this.transport.resumeOutputAudio();
        if (this.state.activity !== "user-speaking") this.set({ activity: "thinking" });
        break;
      case "audio-transcript-delta": {
        this.armIdle();
        this.modelSpeaking = true;
        if (!this.currentItem || this.currentItem.id !== e.itemId) this.currentItem = { id: e.itemId, startedAt: this.o.now() };
        const id = `a-${e.itemId}`;
        const cur = this.state.transcript.find((x) => x.id === id);
        this.upsertEntry({ id, role: "assistant", text: (cur?.text ?? "") + e.delta, final: false });
        if (this.state.activity !== "user-speaking") this.set({ activity: "model-speaking" });
        break;
      }
      case "audio-transcript-done": {
        const id = `a-${e.itemId}`;
        const cur = this.state.transcript.find((x) => x.id === id);
        const text = (e.transcript || cur?.text || "").trim();
        if (text) {
          this.upsertEntry({ id, role: "assistant", text, final: true, interrupted: cur?.interrupted });
          if (!this.reported.has(id)) {
            this.reported.add(id);
            this.report({ type: "assistant_speech", text, interrupted: !!cur?.interrupted });
          }
        }
        break;
      }
      case "tool-call":
        void this.runTool(e.callId, e.name, e.arguments);
        break;
      case "response-done":
        this.modelSpeaking = false;
        this.currentItem = null;
        this.finalizeStreaming(false);
        if (this.pendingTools === 0 && this.state.activity !== "user-speaking") this.set({ activity: "listening" });
        break;
      case "error": {
        const kind = classifyProviderError(e.code, e.message);
        if (kind === "benign") break;
        if (kind === "fatal") {
          this.userStopped = true;
          this.fail("provider-error");
        } else this.set({ warning: e.message.slice(0, 200) });
        break;
      }
      default:
        break;
    }
  }

  private async runTool(callId: string, name: string, args: string) {
    this.pendingTools++;
    this.set({ activity: "thinking" });
    let output: string;
    try {
      let timer: unknown;
      const res = await Promise.race([
        this.api.runTool({ name, arguments: args, callId }),
        new Promise<never>((_, rej) => (timer = this.o.setTimer(() => rej(new Error("tool timeout")), this.o.toolTimeoutMs))),
      ]).finally(() => this.o.clearTimer(timer));
      output = res.output;
    } catch {
      output = JSON.stringify({ error: "tool_unavailable", message: "تعذّر الوصول إلى الكتاب الآن؛ أخبر الطالب بذلك ولا تخمّن." });
    }
    this.pendingTools--;
    if (this.state.phase !== "live") return;
    this.transport.send(clientEvents.toolOutput(callId, output));
    if (this.pendingTools === 0) this.transport.send(clientEvents.respond());
  }

  // ───────────────────────────── transcript helpers ─────────────────────────────
  private addEntry(e: TranscriptEntry) {
    this.upsertEntry(e);
  }
  private upsertEntry(e: TranscriptEntry) {
    const list = this.state.transcript.some((x) => x.id === e.id)
      ? this.state.transcript.map((x) => (x.id === e.id ? { ...x, ...e } : x))
      : [...this.state.transcript, e];
    this.set({ transcript: list.slice(-200) });
  }
  private finalizeStreaming(interrupted: boolean) {
    if (!this.state.transcript.some((x) => !x.final && x.role === "assistant")) return;
    const closing = this.state.transcript.filter((x) => !x.final && x.role === "assistant" && x.text.trim());
    this.set({ transcript: this.state.transcript.map((x) => (!x.final && x.role === "assistant" ? { ...x, final: true, interrupted: interrupted || x.interrupted } : x)) });
    for (const x of closing) {
      if (this.reported.has(x.id)) continue;
      this.reported.add(x.id);
      this.report({ type: "assistant_speech", text: x.text.trim(), interrupted });
    }
  }

  // ───────────────────────────── reconnect ─────────────────────────────
  /** Call when the page becomes visible again (mobile browsers suspend audio in the background). */
  handleVisibility(visible: boolean) {
    if (visible && this.state.phase === "live" && !this.transport.isOpen()) void this.onClose("resume-dead");
  }

  private async onClose(_reason: string) {
    if (this.userStopped || this.reconnecting) return;
    if (this.state.phase !== "live" && this.state.phase !== "reconnecting") return;
    this.reconnecting = true;
    this.modelSpeaking = false;
    this.currentItem = null;
    this.finalizeStreaming(true);
    this.report({ type: "state", voice: "reconnecting" });
    try {
      for (let attempt = 1; attempt <= this.o.maxReconnects; attempt++) {
        this.set({ phase: "reconnecting", activity: null, reconnectAttempt: attempt });
        if (this.o.isOnline && !this.o.isOnline() && this.o.onceOnline) {
          await new Promise<void>((res) => {
            const off = this.o.onceOnline!(() => (off(), res()));
            this.o.setTimer(() => (off(), res()), 30_000);
          });
        }
        await new Promise<void>((res) => this.o.setTimer(res, Math.min(8000, 1000 * 2 ** (attempt - 1))));
        if (this.userStopped) return;
        this.transport.close();
        const r = await this.connectOnce();
        if (this.userStopped) return;
        if (r.ok) {
          this.set({ phase: "live", activity: "listening", reconnectAttempt: 0 });
          this.armIdle();
          this.transport.send(clientEvents.text("system", this.resumeNotice()));
          this.report({ type: "state", voice: "reconnected" });
          return;
        }
        // Retrying cannot fix these; stop immediately with the specific reason.
        if (r.code === "budget" || r.code === "rate-limited" || r.code === "not-configured") return this.fail(r.code);
      }
      this.fail("connection-lost");
    } finally {
      this.reconnecting = false;
    }
  }

  private resumeNotice(): string {
    const recent = this.state.transcript.filter((t) => t.final && t.text).slice(-6)
      .map((t) => `${t.role === "user" ? "الطالب" : "المعلّم"}: ${t.text.slice(0, 300)}`).join("\n");
    const page = this.o.getResumeContext?.();
    return [
      "تنبيه: انقطع الاتصال لحظات ثم عاد. تابع من حيث توقفتم دون إعادة التعريف بنفسك.",
      recent ? `آخر ما دار في المحادثة:\n${recent}` : "",
      page ?? "",
    ].filter(Boolean).join("\n\n");
  }
}
