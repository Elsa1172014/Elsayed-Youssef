import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

/** Plays HLS directly from the stream's origin; the backend never proxies media. */
export function Player({ channelId, onWatched }: { channelId: string; onWatched: (seconds: number) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let cancelled = false;
    let hls: Hls | undefined;
    const started = Date.now();
    setError("");
    api
      .streamUrl(channelId)
      .then((url) => {
        if (cancelled) return;
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = url;
        } else if (Hls.isSupported()) {
          hls = new Hls();
          hls.on(Hls.Events.ERROR, (_e, d) => d.fatal && setError("This stream failed to play."));
          hls.loadSource(url);
          hls.attachMedia(video);
        } else {
          setError("HLS is not supported in this browser.");
        }
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

  return (
    <div className="player">
      <video ref={ref} controls autoPlay playsInline />
      {error && <p className="error">{error}</p>}
    </div>
  );
}
