"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CAMERA_MESSAGE_AR, openCamera, stopStream, type CameraStatus } from "@/lib/vision/camera";
import { ISSUE_MESSAGE_AR, StabilityTracker, toGray, type StabilityIssue } from "@/lib/vision/stability";

const ANALYSIS_W = 96;
const ANALYSIS_H = 72;
const MAX_DIM = 1280;
const TICK_MS = 200;

interface Props {
  /** Called with a JPEG of the page. Resolve when the server round-trip is done (re-arms auto capture). */
  onCapture: (jpeg: Blob) => Promise<void>;
  disabled?: boolean;
}

export function CameraPanel({ onCapture, disabled }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackerRef = useRef(new StabilityTracker());
  const inFlight = useRef(false);
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [issue, setIssue] = useState<StabilityIssue | null>(null);
  const [auto, setAuto] = useState(true);
  const [captured, setCaptured] = useState(false);

  const stop = useCallback(() => {
    stopStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStatus((s) => (s === "live" ? "idle" : s));
  }, []);

  const start = useCallback(async () => {
    setStatus("requesting");
    trackerRef.current.reset();
    const r = await openCamera(navigator.mediaDevices, window.isSecureContext);
    if (!r.ok) return setStatus(r.status);
    streamRef.current = r.stream;
    const v = videoRef.current;
    if (v) {
      v.srcObject = r.stream;
      v.setAttribute("playsinline", "true"); // iOS Safari
      await v.play().catch(() => undefined);
    }
    setStatus("live");
  }, []);

  const grab = useCallback(async (): Promise<Blob | null> => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const scale = Math.min(1, MAX_DIM / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob((b) => res(b), "image/jpeg", 0.82));
  }, []);

  const capture = useCallback(async () => {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    try {
      const blob = await grab();
      if (!blob) return;
      trackerRef.current.markCaptured();
      setCaptured(true);
      await onCapture(blob);
    } finally {
      inFlight.current = false;
      setTimeout(() => setCaptured(false), 1200);
    }
  }, [grab, onCapture, disabled]);

  // Stability analysis loop: small downscaled frames, 5 fps. Nothing is uploaded here.
  useEffect(() => {
    if (status !== "live") return;
    const canvas = document.createElement("canvas");
    canvas.width = ANALYSIS_W;
    canvas.height = ANALYSIS_H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const id = setInterval(() => {
      const v = videoRef.current;
      if (!ctx || !v || v.readyState < 2) return;
      ctx.drawImage(v, 0, 0, ANALYSIS_W, ANALYSIS_H);
      const s = trackerRef.current.push(toGray(ctx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H)));
      setIssue(s.issue);
      if (s.ready && auto && !inFlight.current && !disabled) void capture();
    }, TICK_MS);
    return () => clearInterval(id);
  }, [status, auto, capture, disabled]);

  // Release the camera when the tab is hidden or the component unmounts.
  useEffect(() => {
    const onHide = () => document.hidden && stop();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      stopStream(streamRef.current);
    };
  }, [stop]);

  const failed = status !== "idle" && status !== "requesting" && status !== "live";
  return (
    <section aria-label="الكاميرا" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-bold">الكاميرا</h2>
        {status === "live" && <span className="flex items-center gap-1 text-xs text-ok"><span aria-hidden className="size-2 animate-pulse rounded-full bg-ok" />تعمل</span>}
      </div>
      <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-black/80">
        <video ref={videoRef} muted playsInline aria-label="معاينة الكاميرا" className={`size-full object-cover ${status === "live" ? "" : "invisible"}`} />
        {status !== "live" && (
          <div className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-white/80">
            {status === "requesting" ? "بانتظار إذن الكاميرا…" : failed ? CAMERA_MESSAGE_AR[status] : "الكاميرا متوقفة"}
          </div>
        )}
        {status === "live" && (
          <div aria-hidden className={`pointer-events-none absolute inset-3 rounded-lg border-2 border-dashed ${captured ? "border-ok" : issue ? "border-accent" : "border-white/60"}`} />
        )}
        {captured && <div className="absolute inset-x-0 bottom-2 mx-auto w-fit rounded-full bg-ok px-3 py-1 text-xs font-semibold text-white">تم التقاط الصفحة</div>}
      </div>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted">
        {status === "live" ? (issue ? ISSUE_MESSAGE_AR[issue] : auto ? "ثابتة وواضحة — سيتم الالتقاط تلقائيًا" : "جاهزة") : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {status === "live" ? (
          <>
            <button type="button" onClick={() => void capture()} disabled={disabled} className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-brand-ink disabled:opacity-50">التقط الآن</button>
            <button type="button" onClick={stop} className="rounded-lg border border-line px-3 py-1.5 text-sm">إيقاف</button>
            <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />التقاط تلقائي عند الثبات</label>
          </>
        ) : (
          <button type="button" onClick={() => void start()} disabled={status === "requesting"} className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-brand-ink disabled:opacity-50">
            {failed ? "إعادة المحاولة" : "تشغيل الكاميرا"}
          </button>
        )}
      </div>
    </section>
  );
}
