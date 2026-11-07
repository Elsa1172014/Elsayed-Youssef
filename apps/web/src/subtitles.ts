// Arabic subtitles for any channel.
// 1) If the stream carries its own Arabic subtitle track (HLS/DASH WebVTT), show it: perfectly in sync, no AI.
// 2) Otherwise "live AI subtitles": record the channel's sound in short clips, send each clip to the API
//    (Gemini transcribes + translates to Arabic) and show the result over the picture. Audio is never stored.
import { api } from "./api";

export type SubStatus =
  | { kind: "idle" }
  | { kind: "track"; label: string }
  | { kind: "live" }
  | { kind: "error"; message: string };

const CLIP_MS = 6000;
const MAX_IN_FLIGHT = 2;

/** An Arabic text track already present in the stream (hls.js and Safari expose them on the <video>). */
export function findArabicTrack(video: HTMLVideoElement): TextTrack | undefined {
  const list = Array.from(video.textTracks ?? []);
  return list.find((t) => /^ar(a)?\b|arab|عرب/i.test(`${t.language} ${t.label}`));
}

export function showTrack(video: HTMLVideoElement, track: TextTrack | undefined) {
  for (const t of Array.from(video.textTracks ?? [])) t.mode = t === track ? "showing" : "disabled";
}

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
}

type CaptureVideo = HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };

/**
 * Starts live AI subtitles on a playing <video>. Returns a stop function.
 * onText receives each new subtitle line ("" = nothing spoken in that clip).
 */
export function startLiveSubtitles(video: HTMLVideoElement, onText: (text: string) => void, onError: (message: string) => void): () => void {
  const v = video as CaptureVideo;
  const mime = pickMime();
  if (!mime || (!v.captureStream && !v.mozCaptureStream)) {
    onError("الترجمة الفورية غير مدعومة في هذا المتصفح. استخدم Chrome أو Edge على الكمبيوتر أو أندرويد.");
    return () => undefined;
  }
  let stopped = false;
  let inFlight = 0;
  let recorder: MediaRecorder | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let audioCtx: AudioContext | undefined;
  let stream: MediaStream;
  try {
    if (v.captureStream) stream = v.captureStream();
    else {
      // Firefox's mozCaptureStream silences the element: route the captured sound back to the speakers.
      stream = v.mozCaptureStream!();
      audioCtx = new AudioContext();
      audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);
    }
  } catch {
    onError("تعذّر الوصول إلى صوت هذه القناة. جرّب إعادة تحميلها، أو اختر مصدرًا آخر لها.");
    return () => undefined;
  }

  const recordClip = () => {
    if (stopped) return;
    const tracks = stream.getAudioTracks();
    if (!tracks.length || video.paused) {
      timer = setTimeout(recordClip, 1000); // no sound yet (still loading) or paused: check again shortly
      return;
    }
    const chunks: Blob[] = [];
    try {
      recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, audioBitsPerSecond: 32_000 });
    } catch {
      onError("تعذّر تسجيل صوت القناة في هذا المتصفح.");
      return;
    }
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      if (!stopped) recordClip(); // start the next clip immediately, keep the pipeline continuous
      const blob = new Blob(chunks, { type: mime });
      if (blob.size < 2000 || inFlight >= MAX_IN_FLIGHT) return; // silence, or the model is behind: skip this clip
      inFlight++;
      void toBase64(blob)
        .then((audio) => api.subtitle(audio, mime))
        .then((r) => !stopped && onText(r.text))
        .catch((e: Error) => {
          if (stopped) return;
          if (/limit|429/i.test(e.message)) { stopped = true; onError("انتهى حدّ الترجمة لهذه الساعة. حاول لاحقًا."); }
          else if (/GEMINI|503/i.test(e.message)) { stopped = true; onError("الترجمة تحتاج مفتاح Gemini على الخادم."); }
          else if (/security|tainted|cross-origin/i.test(e.message)) { stopped = true; onError("مصدر هذه القناة يمنع قراءة صوتها. اختر «إعادة التحميل» أو مصدرًا آخر."); }
        })
        .finally(() => inFlight--);
    };
    try {
      recorder.start();
    } catch (e) {
      onError(/security/i.test(String(e)) ? "مصدر هذه القناة يمنع قراءة صوتها. جرّب مصدرًا آخر." : "تعذّر بدء الترجمة.");
      return;
    }
    timer = setTimeout(() => recorder?.state === "recording" && recorder.stop(), CLIP_MS);
  };
  recordClip();

  return () => {
    stopped = true;
    clearTimeout(timer);
    if (recorder?.state === "recording") recorder.stop();
    void audioCtx?.close().catch(() => undefined);
  };
}

/** Splits a window's translation into readable sentences, to show one after another across the window. */
export function splitSubtitle(text: string): string[] {
  const parts = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?؟。…])\s+|(?<=[،,;؛])\s+(?=\S{2,}\s+\S+\s+\S+)/u).map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && (last.length + p.length < 70)) out[out.length - 1] = `${last} ${p}`; else out.push(p);
  }
  return out.length ? out : [text];
}

/**
 * Server-side live subtitles (HLS): every ~window the server translates the latest ~9–12 s of the channel's audio,
 * near the point being watched. Requests overlap (max 2 in flight) so a slow answer never makes the subtitles fall
 * behind; out-of-date answers are dropped. Works on every device, including iPhone/Safari.
 */
export function startServerSubtitles(channelId: string, onText: (text: string, seconds: number) => void, onError: (message: string) => void, onFallback: () => void): () => void {
  let stopped = false;
  let after: number | undefined;
  let shownSeq = -1;
  let prev: string | undefined;
  let inFlight = 0;
  let failures = 0;
  let period = 10;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (why?: () => void) => { stopped = true; clearTimeout(timer); why?.(); };
  const request = async () => {
    inFlight++;
    try {
      const r = await api.subtitleLive(channelId, after, prev);
      if (stopped) return;
      failures = 0;
      if (r.wait) period = Math.min(Math.max(r.wait, 4), 20);
      if (r.seq === undefined || r.seq <= shownSeq) return; // late answer for a window already shown
      shownSeq = r.seq;
      after = r.seq;
      if (r.text) { prev = r.text; onText(r.text, r.duration ?? period); }
    } catch (e) {
      if (stopped) return;
      const m = (e as Error).message;
      if (/not an HLS|no supported audio|unreachable|no playable/i.test(m)) return stop(onFallback);
      if (/encrypted/i.test(m)) return stop(() => onError("هذه القناة مشفّرة، ولا تُترجم لأن صوتها محمي."));
      if (/limit|429/i.test(m)) return stop(() => onError("انتهى حدّ الترجمة لهذه الساعة. حاول لاحقًا."));
      if (/GEMINI|503/i.test(m)) return stop(() => onError("الترجمة تحتاج مفتاح Gemini على الخادم."));
      if (++failures >= 4) return stop(() => onError("تعذّرت الترجمة لهذه القناة الآن."));
    } finally { inFlight--; }
  };
  const loop = () => {
    if (stopped) return;
    if (inFlight < 2) void request();
    timer = setTimeout(loop, period * 1000);
  };
  loop();
  return () => stop();
}
