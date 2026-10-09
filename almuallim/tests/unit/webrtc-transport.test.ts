import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebRtcTransport, type WebRtcEnv } from "@/lib/voice/webrtc-transport";

class FakeDC {
  readyState = "connecting";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: { data: unknown }) => void) | null = null;
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = "closed"; }
  open() { this.readyState = "open"; this.onopen?.(); }
}
class FakePC {
  static last: FakePC;
  connectionState = "new";
  dc = new FakeDC();
  tracks: unknown[] = [];
  localDescription: unknown;
  remoteDescription: unknown;
  ontrack: ((e: { streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  closed = false;
  constructor() { FakePC.last = this; }
  addTrack(t: unknown) { this.tracks.push(t); }
  createDataChannel(label: string) { expect(label).toBe("oai-events"); return this.dc as unknown as RTCDataChannel; }
  async createOffer() { return { type: "offer", sdp: "v=0 OFFER" }; }
  async setLocalDescription(d: unknown) { this.localDescription = d; }
  async setRemoteDescription(d: unknown) { this.remoteDescription = d; setTimeout(() => { this.connectionState = "connected"; this.dc.open(); }, 0); }
  close() { this.closed = true; this.connectionState = "closed"; }
  setState(s: string) { this.connectionState = s; this.onconnectionstatechange?.(); }
}

const track = () => ({ enabled: true, readyState: "live", stopped: false, stop() { this.stopped = true; this.readyState = "ended"; } });
function env(over: Partial<WebRtcEnv> = {}) {
  const t = track();
  const stream = { getAudioTracks: () => [t], getTracks: () => [t] } as unknown as MediaStream;
  const audio = { autoplay: false, muted: false, srcObject: null as unknown, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), setAttribute: vi.fn() };
  const fetchMock = vi.fn(async () => new Response("v=0 ANSWER", { status: 200 }));
  const e: WebRtcEnv = {
    RTCPeerConnection: FakePC as unknown as WebRtcEnv["RTCPeerConnection"],
    mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    createAudio: () => audio as unknown as HTMLAudioElement,
    fetch: fetchMock as unknown as typeof fetch,
    isSecureContext: true,
    ...over,
  };
  return { e, t, audio, fetchMock };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function connected(over: Partial<WebRtcEnv> = {}) {
  const x = env(over);
  const tr = new WebRtcTransport(x.e);
  await tr.acquireMic();
  const p = tr.connect({ clientSecret: "ek_abc", callsUrl: "https://api.example/v1/realtime/calls" });
  await vi.advanceTimersByTimeAsync(5);
  await p;
  return { ...x, tr, pc: FakePC.last };
}

describe("WebRtcTransport", () => {
  it("refuses insecure contexts and missing mediaDevices with the DOM error names the UI maps", async () => {
    await expect(new WebRtcTransport(env({ isSecureContext: false }).e).acquireMic()).rejects.toMatchObject({ name: "SecurityError" });
    await expect(new WebRtcTransport(env({ mediaDevices: undefined }).e).acquireMic()).rejects.toMatchObject({ name: "TypeError" });
  });

  it("requests a mic with echo cancellation/noise suppression (classroom use), audio only", async () => {
    const x = env();
    await new WebRtcTransport(x.e).acquireMic();
    expect(x.e.mediaDevices!.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
  });

  it("performs the SDP exchange with the EPHEMERAL secret and opens the events channel", async () => {
    const { fetchMock, pc } = await connected();
    expect(fetchMock).toHaveBeenCalledWith("https://api.example/v1/realtime/calls", {
      method: "POST", body: "v=0 OFFER", headers: { Authorization: "Bearer ek_abc", "Content-Type": "application/sdp" },
    });
    expect(pc.remoteDescription).toEqual({ type: "answer", sdp: "v=0 ANSWER" });
    expect(pc.tracks).toHaveLength(1);
  });

  it("fails connect with a clear error when the provider rejects the exchange", async () => {
    const x = env({ fetch: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch });
    const tr = new WebRtcTransport(x.e);
    await tr.acquireMic();
    await expect(tr.connect({ clientSecret: "ek", callsUrl: "https://x" })).rejects.toThrow(/HTTP 401/);
  });

  it("plays remote audio, forwards JSON events, ignores junk, and sends only on an open channel", async () => {
    const { tr, pc, audio } = await connected();
    const got: unknown[] = [];
    tr.onMessage = (e) => got.push(e);
    pc.ontrack?.({ streams: ["REMOTE"] });
    expect(audio.srcObject).toBe("REMOTE");
    pc.dc.onmessage?.({ data: '{"type":"session.created"}' });
    pc.dc.onmessage?.({ data: "not json" });
    expect(got).toEqual([{ type: "session.created" }]);
    tr.send({ type: "response.create" });
    expect(pc.dc.sent).toEqual(['{"type":"response.create"}']);
    pc.dc.readyState = "closed";
    tr.send({ type: "x" });
    expect(pc.dc.sent).toHaveLength(1);
  });

  it("mute toggles the track; barge-in mutes local playback until the next response", async () => {
    const { tr, t, audio } = await connected();
    tr.setMicEnabled(false);
    expect(t.enabled).toBe(false);
    tr.setMicEnabled(true);
    expect(t.enabled).toBe(true);
    tr.stopOutputAudio();
    expect(audio.muted).toBe(true);
    tr.resumeOutputAudio();
    expect(audio.muted).toBe(false);
    expect(audio.play).toHaveBeenCalled();
  });

  it("reports an unexpected failure exactly once, but not a deliberate close", async () => {
    const { tr, pc } = await connected();
    const onClose = vi.fn();
    tr.onClose = onClose;
    pc.setState("failed");
    pc.setState("closed");
    expect(onClose).toHaveBeenCalledTimes(1);

    const b = await connected();
    const onClose2 = vi.fn();
    b.tr.onClose = onClose2;
    b.tr.close();
    expect(onClose2).not.toHaveBeenCalled();
  });

  it("tolerates a brief 'disconnected' (network blip) but reports a sustained one", async () => {
    const { tr, pc } = await connected();
    const onClose = vi.fn();
    tr.onClose = onClose;
    pc.setState("disconnected");
    await vi.advanceTimersByTimeAsync(2000);
    pc.setState("connected");
    await vi.advanceTimersByTimeAsync(5000);
    expect(onClose).not.toHaveBeenCalled();
    pc.setState("disconnected");
    await vi.advanceTimersByTimeAsync(4001);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("close() keeps the microphone for reconnect; release() stops it so the browser indicator turns off", async () => {
    const { tr, t, pc } = await connected();
    tr.close();
    expect(pc.closed).toBe(true);
    expect(t.stopped).toBe(false);
    tr.release();
    expect(t.stopped).toBe(true);
  });
});
