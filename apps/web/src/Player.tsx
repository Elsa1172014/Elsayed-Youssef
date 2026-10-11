import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

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

/**
 * Plays HLS. Direct from the stream's origin when the browser can (https + CORS), otherwise through the API's
 * signed relay (mixed content / missing CORS). Dead or blocked streams get a clear message.
 */
export function Player({ channelId, onWatched }: { channelId: string; onWatched: (seconds: number) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [theater, setTheater] = useState(false);
  const [error, setError] = useState("");
  const [via, setVia] = useState<"" | "direct" | "relay">("");

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let cancelled = false;
    let hls: Hls | undefined;
    const started = Date.now();
    setError("");
    setVia("");

    const play = (url: string, onFatal: () => void) => {
      hls?.destroy();
      hls = undefined;
      if (/\.m3u8?(\?|$)/i.test(url) === false && !url.includes("/v1/proxy")) {
        // Not an HLS URL (plain TS/MP4): let the browser try natively.
        video.src = url;
        video.onerror = onFatal;
        return;
      }
      if (Hls.isSupported()) {
        const h = new Hls({ manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 2 });
        hls = h;
        h.on(Hls.Events.ERROR, (_e, d) => {
          if (d.fatal && !cancelled) onFatal();
        });
        h.loadSource(url);
        h.attachMedia(video);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        video.onerror = onFatal;
      } else {
        setError("HLS is not supported in this browser.");
      }
    };

    api
      .stream(channelId)
      .then(({ url, proxy }) => {
        if (cancelled) return;
        const insecurePage = location.protocol === "https:" && url.startsWith("http:");
        const viaRelay = () => {
          setVia("relay");
          play(proxy, () => {
            if (cancelled) return;
            hls?.destroy();
            void relayReason(proxy).then((m) => !cancelled && setError(m));
          });
        };
        if (insecurePage) return viaRelay(); // browsers block http media on https pages
        setVia("direct");
        play(url, viaRelay); // direct failed (usually CORS): retry through the relay once
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
      hls?.destroy();
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
  useEffect(() => {
    if (!theater) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setTheater(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [theater]);

  return (
    <div className={theater ? "player theater" : "player"} ref={box}>
      <video ref={ref} controls autoPlay playsInline onDoubleClick={fullscreen} />
      <div className="fs">
        <button type="button" onClick={() => setTheater((t) => !t)} aria-label="Wide view" title="Wide view">▭</button>
        <button type="button" onClick={fullscreen} aria-label="Fullscreen" title="Fullscreen">⛶</button>
      </div>
      {error ? <p className="error">{error}</p> : via === "relay" && <p className="hint">via relay</p>}
    </div>
  );
}
