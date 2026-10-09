"use client";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { RealtimeVoiceClient, VoiceApiError, type ReportEvent, type VoiceApi, type VoiceErrorCode, type VoiceState } from "@/lib/voice/client";
import { browserEnv, WebRtcTransport } from "@/lib/voice/webrtc-transport";

const IDLE: VoiceState = { phase: "idle", activity: null, muted: false, error: null, warning: null, reconnectAttempt: 0, transcript: [] };

function tokenErrorCode(status: number, code: string | undefined): VoiceErrorCode {
  if (status === 429) return code === "budget_exceeded" ? "budget" : "rate-limited";
  if (status === 503) return "not-configured";
  return "token-failed";
}

export function supportsVoice(): boolean {
  return typeof window !== "undefined" && !!window.RTCPeerConnection && !!navigator.mediaDevices?.getUserMedia;
}

/** Connects the voice state machine to the browser, our API routes, and React. */
export function useVoiceSession(opts: { getSessionId: () => Promise<string>; getResumeContext?: () => string | null }) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const sessionIdRef = useRef<string | null>(null);

  const client = useMemo(() => {
    if (typeof window === "undefined") return null;
    const api: VoiceApi = {
      async fetchToken() {
        const sessionId = await optsRef.current.getSessionId();
        sessionIdRef.current = sessionId;
        const r = await fetch("/api/realtime/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new VoiceApiError(tokenErrorCode(r.status, j?.error?.code));
        return { clientSecret: j.clientSecret as string, callsUrl: j.callsUrl as string };
      },
      async runTool(call) {
        const r = await fetch("/api/realtime/tool", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sessionIdRef.current, name: call.name, arguments: call.arguments, callId: call.callId }),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j) throw new Error("tool request failed");
        return { output: String(j.output) };
      },
      async reportEvents(events: ReportEvent[]) {
        if (!sessionIdRef.current) return;
        await fetch("/api/realtime/events", {
          method: "POST", headers: { "content-type": "application/json" }, keepalive: true,
          body: JSON.stringify({ sessionId: sessionIdRef.current, events }),
        });
      },
    };
    return new RealtimeVoiceClient(new WebRtcTransport(browserEnv()), api, {
      getResumeContext: () => optsRef.current.getResumeContext?.() ?? null,
      isOnline: () => navigator.onLine,
      onceOnline: (cb) => {
        window.addEventListener("online", cb, { once: true });
        return () => window.removeEventListener("online", cb);
      },
    });
  }, []);

  const subscribe = useCallback((fn: () => void) => (client ? client.subscribe(fn) : () => undefined), [client]);
  const state = useSyncExternalStore(subscribe, () => client?.getState() ?? IDLE, () => IDLE);

  useEffect(() => {
    if (!client) return;
    const onVis = () => client.handleVisibility(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      void client.stop();
    };
  }, [client]);

  return {
    state,
    start: () => client?.start() ?? Promise.resolve(),
    stop: () => client?.stop() ?? Promise.resolve(),
    setMuted: (m: boolean) => client?.setMuted(m),
    interrupt: () => client?.interrupt(),
    sendText: (t: string) => client?.sendText(t),
    pushContext: (t: string, o?: { speak?: boolean }) => client?.pushContext(t, o) ?? false,
  };
}
