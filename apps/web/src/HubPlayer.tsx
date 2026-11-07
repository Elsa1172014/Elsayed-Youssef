import { useEffect, useRef, useState } from "react";
import type { HubPlaySource } from "./api";
import { startEngine, type Handle } from "./engine";

const DRM_NAMES: Record<string, string> = { widevine: "Widevine", playready: "PlayReady", fairplay: "FairPlay", clearkey: "ClearKey" };

/**
 * Plays one licensed Hub source with Shaka Player (HLS / DASH / MP4).
 * Protected content uses only the rights holder's official license server; the browser's CDM does the decryption.
 */
export function HubPlayer({ source, onClose }: { source: HubPlaySource; onClose: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const [tap, setTap] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let handle: Handle | undefined;
    let cancelled = false;
    setError("");
    const license = source.drmSystem && source.licenseUrl ? { system: source.drmSystem, url: source.licenseUrl } : undefined;
    const engine = source.kind === "mp4" && !license ? "native" : "shaka";
    void startEngine(video, { url: source.url, mode: "direct", engine, kind: source.kind === "dash" ? "dash" : source.kind === "mp4" ? "mp4" : "hls", license }, {
      onFatal: (r) => {
        if (cancelled) return;
        setError(r.cause === "drm_protected"
          ? `تعذّر الحصول على ترخيص ${DRM_NAMES[source.drmSystem ?? ""] ?? "DRM"} من خادم صاحب الحقوق، أو أن هذا الجهاز لا يدعمه.`
          : r.cause === "codec_unsupported" ? "صيغة الفيديو غير مدعومة على هذا الجهاز." : "تعذّر تشغيل هذا المصدر الآن. حاول لاحقًا.");
      },
    }).then((h) => {
      if (cancelled) return h.destroy();
      handle = h;
      video.play().catch((e: Error) => !cancelled && e.name === "NotAllowedError" && setTap(true));
    }).catch(() => !cancelled && setError("تعذّر بدء المشغّل."));
    return () => { cancelled = true; handle?.destroy(); };
  }, [source]);

  return (
    <div className="hub-player" role="dialog" aria-label={source.label}>
      <div className="player">
        <video ref={ref} controls playsInline autoPlay />
        {tap && <button type="button" className="bigplay" onClick={() => { setTap(false); void ref.current?.play(); }}>▶ تشغيل</button>}
      </div>
      <div className="hub-player-bar">
        <span>{source.label}{source.drmSystem ? ` · محمي بـ ${DRM_NAMES[source.drmSystem]} (ترخيص رسمي)` : ""} · Shaka Player</span>
        <button type="button" onClick={onClose}>✕ إغلاق</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
