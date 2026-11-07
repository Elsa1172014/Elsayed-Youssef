import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { detectStreamKind, type Engine, type StreamKind } from "./core";
import { forgetSource, recallSource, startEngine, type Handle } from "./engine";
import { findArabicTrack, showTrack, startLiveSubtitles } from "./subtitles";

/** Asks the relay why it refused (offline, geo-blocked, ...) so the viewer sees a reason instead of a spinner. */
async function relayReason(proxyUrl: string): Promise<string> {
  try {
    const r = await fetch(proxyUrl);
    if (!r.ok) return ((await r.json()) as { error?: string }).error ?? `Stream error (${r.status})`;
  } catch {
    /* network error: fall through */
  }
  return "This stream failed to play. It may be offline or restricted to another country.";
}

const defaultEngine = (kind: StreamKind): Engine => (kind === "dash" ? "dashjs" : kind === "hls" || kind === "unknown" ? "hlsjs" : "native");

/**
 * Plays a channel. Direct from the stream's origin when the browser can (https + CORS), otherwise through the API's
 * signed relay (mixed content / missing CORS). If the AI "Repair & Play" found a better source for this channel on
 * this device, that remembered source is tried first. A browser that blocks autoplay gets a clear Play button.
 */
export function Player({ channelId, onWatched, onFailed, onPlaying: onPlayingCb, relayLabel = "via server", relayTip = "", playLabel = "Play", fixedLabel = "" }: { channelId: string; onWatched: (seconds: number) => void; onFailed?: () => void; onPlaying?: () => void; relayLabel?: string; relayTip?: string; playLabel?: string; fixedLabel?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [theater, setTheater] = useState(false);
  const [error, setError] = useState("");
  const [via, setVia] = useState<"" | "direct" | "relay">("");
  const [tap, setTap] = useState(false);
  const [repaired, setRepaired] = useState(false);
  // Arabic subtitles: remembered on this device, so they follow the viewer from channel to channel.
  const [subsOn, setSubsOn] = useState(() => { try { return localStorage.getItem("receiver.subs") === "1"; } catch { return false; } });
  const [subLines, setSubLines] = useState<string[]>([]);
  const [subNote, setSubNote] = useState("");
  const [playingNow, setPlayingNow] = useState(false);
  useEffect(() => { try { localStorage.setItem("receiver.subs", subsOn ? "1" : "0"); } catch { /* ignore */ } }, [subsOn]);
  useEffect(() => {
    const video = ref.current;
    if (!video || !subsOn || !playingNow) { setSubLines([]); setSubNote(""); if (video) showTrack(video, undefined); return; }
    const track = findArabicTrack(video);
    if (track) { showTrack(video, track); setSubNote("ترجمة عربية مدمجة في البث"); return () => showTrack(video, undefined); }
    setSubNote("الترجمة الفورية تعمل… تظهر بعد ثوانٍ من الكلام");
    let clearT: ReturnType<typeof setTimeout> | undefined;
    const stop = startLiveSubtitles(video, (text) => {
      if (!text) return;
      setSubNote("");
      setSubLines((l) => [...l, text].slice(-2));
      clearTimeout(clearT);
      clearT = setTimeout(() => setSubLines([]), 9000);
    }, (m) => setSubNote(m));
    return () => { stop(); clearTimeout(clearT); };
  }, [subsOn, playingNow]);
  const pipOk = typeof document !== "undefined" && "pictureInPictureEnabled" in document && document.pictureInPictureEnabled;
  useEffect(() => { if (error) onFailed?.(); }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let cancelled = false;
    let handle: Handle | undefined;
    let nudges = 0;
    let stall: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    setError("");
    setVia("");
    setTap(false);

    const tryAutoplay = () =>
      video.play().catch((e: Error) => {
        if (e.name === "NotAllowedError" && !cancelled) setTap(true);
      });
    const onPlaying = () => {
      setTap(false);
      setPlayingNow(true);
      onPlayingCb?.();
      clearTimeout(stall);
    };
    // Long buffering: restart loading a couple of times, never in a loop.
    const onWaiting = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        if (!cancelled && nudges++ < 2) handle?.nudge?.();
      }, 10_000);
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);

    const start = async (url: string, mode: "direct" | "relay", engine: Engine, kind: StreamKind, onFatal: () => void) => {
      handle?.destroy();
      handle = undefined;
      // Extension-less direct URLs are usually raw TS/MP4 streams: let the browser handle them; relays always serve HLS or segments.
      const eng: Engine = engine === "hlsjs" && kind === "unknown" && mode === "direct" ? "native" : engine;
      const h = await startEngine(video, { url, mode, engine: eng, kind }, { onFatal: () => !cancelled && onFatal() });
      if (cancelled) return h.destroy();
      handle = h;
      void tryAutoplay();
    };

    const pref = recallSource(channelId);
    api
      .stream(channelId)
      .then(({ url, proxy }) => {
        if (cancelled) return;
        const alt = pref && pref.origin !== "current" ? pref : undefined;
        const src = alt ? { url: alt.url, proxy: alt.proxy } : { url, proxy };
        const kind = pref?.kind ?? detectStreamKind(src.url);
        const engine = pref?.engine ?? defaultEngine(kind);
        setRepaired(!!pref);
        const insecurePage = location.protocol === "https:" && src.url.startsWith("http:");
        const viaRelay = () => {
          setVia("relay");
          void start(src.proxy, "relay", engine, kind, () => {
            if (cancelled) return;
            handle?.destroy();
            if (pref) forgetSource(channelId); // the remembered source stopped working: next time use the channel's own link
            void relayReason(src.proxy).then((m) => !cancelled && setError(m));
          }).catch((e: Error) => !cancelled && setError(e.message));
        };
        if (insecurePage || pref?.mode === "relay") return viaRelay(); // browsers block http media on https pages
        setVia("direct");
        void start(src.url, "direct", engine, kind, viaRelay).catch(viaRelay); // direct failed (usually CORS): retry through the relay once
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
      clearTimeout(stall);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      handle?.destroy();
      const seconds = Math.round((Date.now() - started) / 1000);
      if (seconds >= 10) onWatched(seconds);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  const fullscreen = () => {
    const el = box.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    const v = ref.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (el?.requestFullscreen) void el.requestFullscreen().catch(() => setTheater(true));
    else if (v?.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iPhone Safari only fullscreens the <video>
    else setTheater((t) => !t);
  };
  const pip = () => {
    const v = ref.current;
    if (!v) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
    else void v.requestPictureInPicture().catch(() => undefined);
  };
  useEffect(() => {
    if (!theater) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setTheater(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [theater]);

  return (
    <div className={theater ? "player theater" : "player"} ref={box}>
      <video ref={ref} controls autoPlay playsInline onDoubleClick={fullscreen} />
      {subsOn && subLines.length > 0 && <div className="subs" dir="rtl" lang="ar" aria-live="polite">{subLines.map((l, i) => <p key={i}>{l}</p>)}</div>}
      {subsOn && subNote && <p className="subnote" dir="rtl">{subNote}</p>}
      {tap && <button type="button" className="bigplay" onClick={() => { setTap(false); void ref.current?.play(); }}>▶ {playLabel}</button>}
      <div className="fs">
        <button type="button" className={subsOn ? "subbtn on" : "subbtn"} aria-pressed={subsOn} onClick={() => setSubsOn((x) => !x)} title="ترجمة عربية" aria-label="ترجمة عربية">ع</button>
        {pipOk && <button type="button" onClick={pip} aria-label="Picture in picture" title="Picture in picture">⧉</button>}
        <button type="button" onClick={() => setTheater((t) => !t)} aria-label="Wide view" title="Wide view">▭</button>
        <button type="button" onClick={fullscreen} aria-label="Fullscreen" title="Fullscreen">⛶</button>
      </div>
      {error ? <p className="error">{error}</p> : via === "relay" && <p className="hint" title={relayTip}>ⓘ {relayLabel}</p>}
      {!error && repaired && fixedLabel && <p className="hint">✦ {fixedLabel}</p>}
    </div>
  );
}
