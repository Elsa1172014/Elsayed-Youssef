import type { RealtimeTransport } from "./client";

/** Browser primitives, injectable for tests. */
export interface WebRtcEnv {
  RTCPeerConnection: new (config?: RTCConfiguration) => RTCPeerConnection;
  mediaDevices: Pick<MediaDevices, "getUserMedia"> | undefined;
  createAudio: () => HTMLAudioElement;
  fetch: typeof fetch;
  isSecureContext: boolean;
}

export const browserEnv = (): WebRtcEnv => ({
  RTCPeerConnection: window.RTCPeerConnection,
  mediaDevices: navigator.mediaDevices,
  createAudio: () => {
    const a = new Audio();
    a.autoplay = true;
    a.setAttribute("playsinline", "true");
    return a;
  },
  fetch: window.fetch.bind(window),
  isSecureContext: window.isSecureContext,
});

const DISCONNECT_GRACE_MS = 4000;

/**
 * Realtime transport over WebRTC: mic track up, model audio track down, JSON events on the `oai-events`
 * data channel. WebRTC gives us echo cancellation, jitter buffering and good mobile behaviour for free.
 *
 * ⚠ The SDP exchange endpoint (`POST {callsUrl}` with `application/sdp` and the ephemeral secret) follows the
 * provider's documented GA flow but could NOT be exercised in this repo without credentials — see
 * docs/acceptance-tests.md E4.
 */
export class WebRtcTransport implements RealtimeTransport {
  onMessage: ((event: unknown) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  private stream: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audio: HTMLAudioElement | null = null;
  private closing = false;
  private micEnabled = true;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly env: WebRtcEnv) {}

  async acquireMic(): Promise<void> {
    if (!this.env.isSecureContext) throw Object.assign(new Error("insecure context"), { name: "SecurityError" });
    if (!this.env.mediaDevices?.getUserMedia) throw Object.assign(new Error("no getUserMedia"), { name: "TypeError" });
    if (this.stream?.getAudioTracks().some((t) => t.readyState === "live")) return;
    this.stream = await this.env.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    this.applyMic();
  }

  async connect({ clientSecret, callsUrl }: { clientSecret: string; callsUrl: string }): Promise<void> {
    if (!this.stream) await this.acquireMic();
    this.teardownConnection();
    this.closing = false;
    const pc = new this.env.RTCPeerConnection();
    this.pc = pc;
    this.audio ??= this.env.createAudio();
    const audio = this.audio;
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] ?? null;
      void audio.play?.()?.catch?.(() => undefined);
    };
    for (const track of this.stream!.getAudioTracks()) pc.addTrack(track, this.stream!);
    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.onmessage = (m) => {
      try {
        this.onMessage?.(JSON.parse(String(m.data)));
      } catch {
        /* ignore non-JSON frames */
      }
    };

    const opened = new Promise<void>((resolve, reject) => {
      dc.onopen = () => resolve();
      dc.onclose = () => (opened_done ? this.unexpectedClose("datachannel-closed") : reject(new Error("data channel closed before open")));
    });
    let opened_done = false;
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed" || st === "closed") {
        if (opened_done) this.unexpectedClose(`pc-${st}`);
      } else if (st === "disconnected") {
        this.graceTimer ??= setTimeout(() => {
          this.graceTimer = null;
          if (pc.connectionState === "disconnected" && opened_done) this.unexpectedClose("pc-disconnected");
        }, DISCONNECT_GRACE_MS);
      } else if (st === "connected" && this.graceTimer) {
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await this.env.fetch(callsUrl, {
      method: "POST",
      body: offer.sdp,
      headers: { Authorization: `Bearer ${clientSecret}`, "Content-Type": "application/sdp" },
    });
    if (!res.ok) throw new Error(`SDP exchange failed: HTTP ${res.status}`);
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    await opened;
    opened_done = true;
  }

  isOpen(): boolean {
    return this.dc?.readyState === "open" && !!this.pc && !["failed", "closed"].includes(this.pc.connectionState);
  }

  send(event: object): void {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(event));
  }

  setMicEnabled(enabled: boolean): void {
    this.micEnabled = enabled;
    this.applyMic();
  }
  private applyMic() {
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = this.micEnabled));
  }

  stopOutputAudio(): void {
    // Drop locally-buffered model speech immediately; playback jumps to live when resumed.
    if (this.audio) this.audio.muted = true;
  }
  resumeOutputAudio(): void {
    if (this.audio) {
      this.audio.muted = false;
      void this.audio.play?.()?.catch?.(() => undefined);
    }
  }

  private unexpectedClose(reason: string) {
    if (this.closing) return;
    this.closing = true; // report once
    this.onClose?.(reason);
  }

  private teardownConnection() {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.closing = true; // suppress callbacks from the connection we are discarding
    try { this.dc?.close(); } catch { /* already closed */ }
    try { this.pc?.close(); } catch { /* already closed */ }
    this.dc = null;
    this.pc = null;
    this.closing = false;
  }

  close(): void {
    this.teardownConnection();
  }

  release(): void {
    this.teardownConnection();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.audio) {
      this.audio.pause?.();
      this.audio.srcObject = null;
    }
    this.audio = null;
  }
}
