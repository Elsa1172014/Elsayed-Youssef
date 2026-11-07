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

/**
 * Server-side live subtitles (HLS): the server reads the segment being watched and translates its audio.
 * Works on every device, including iPhone/Safari. Resolves "fallback" when the stream needs the in-browser method.
 */
export function startServerSubtitles(channelId: string, onText: (text: string) => void, onError: (message: string) => void, onFallback: () => void): () => void {
  let stopped = false;
  let after: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await api.subtitleLive(channelId, after);
      if (stopped) return;
      failures = 0;
      if (r.seq !== undefined) after = r.seq;
      if (r.text) onText(r.text);
      timer = setTimeout(() => void tick(), Math.max(1, r.wait ?? 4) * 1000);
    } catch (e) {
      if (stopped) return;
      const m = (e as Error).message;
      if (/not an HLS|no supported audio|unreachable|no playable/i.test(m)) { stopped = true; onFallback(); return; }
      if (/encrypted/i.test(m)) { stopped = true; onError("هذه القناة مشفّرة، ولا تُترجم لأن صوتها محمي."); return; }
      if (/limit|429/i.test(m)) { stopped = true; onError("انتهى حدّ الترجمة لهذه الساعة. حاول لاحقًا."); return; }
      if (/GEMINI|503/i.test(m)) { stopped = true; onError("الترجمة تحتاج مفتاح Gemini على الخادم."); return; }
      if (++failures >= 3) { stopped = true; onError("تعذّرت الترجمة لهذه القناة الآن."); return; }
      timer = setTimeout(() => void tick(), 4000);
    }
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
