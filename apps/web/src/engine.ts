import Hls from "hls.js";
import { causeFromHttp, repairAndPlay, type Cause, type Capabilities, type DrmSystem, type PlayRequest, type PlayResult, type RepairDeps } from "./core";
import { api, type Channel } from "./api";

/** Browser side of "Repair & Play": real device checks and a player that only reports success once media is actually flowing. */

const KEY_SYSTEMS: Record<DrmSystem, string> = {
  widevine: "com.widevine.alpha",
  playready: "com.microsoft.playready",
  fairplay: "com.apple.fps.1_0",
  clearkey: "org.w3.clearkey",
};

async function detectDrm(): Promise<DrmSystem[]> {
  if (typeof navigator === "undefined" || !navigator.requestMediaKeySystemAccess) return [];
  const cfg: MediaKeySystemConfiguration[] = [{ initDataTypes: ["cenc", "sinf", "skd"], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }];
  const found: DrmSystem[] = [];
  for (const [name, ks] of Object.entries(KEY_SYSTEMS) as [DrmSystem, string][]) {
    try {
      await navigator.requestMediaKeySystemAccess(ks, cfg);
      found.push(name);
    } catch {
      /* not available on this device */
    }
  }
  return found;
}

const SUBTITLE = /^(stpp|wvtt|cea|c608)/i;

export async function deviceCapabilities(): Promise<Capabilities> {
  const video = document.createElement("video");
  const mse = Hls.isSupported();
  const native = !!video.canPlayType("application/vnd.apple.mpegurl");
  const hasMse = typeof MediaSource !== "undefined";
  return {
    hls: mse && native ? "both" : mse ? "mse" : native ? "native" : "none",
    dash: hasMse,
    drm: await detectDrm(),
    codec(c) {
      if (SUBTITLE.test(c)) return true; // text tracks are not part of the decode path
      const audio = /^(mp4a|ac-3|ec-3|opus|flac|mp3)/i.test(c);
      const type = `${audio ? "audio" : "video"}/mp4; codecs="${c}"`;
      return hasMse ? MediaSource.isTypeSupported(type) : !!video.canPlayType(type);
    },
  };
}

export interface Handle {
  destroy(): void;
  /** Gentle, bounded un-stick for long buffering (restart segment loading). */
  nudge?(): void;
}
export interface Hooks {
  /** Fatal, unrecoverable (after the engine's own bounded recovery) failure. */
  onFatal(r: PlayResult): void;
}

const mediaErrorCause = (code?: number): Cause => (code === 2 ? "network" : code === 3 ? "codec_unsupported" : code === 4 ? "codec_unsupported" : "player_error");

function hlsCause(d: { details?: string; response?: { code?: number }; type?: string }): PlayResult {
  const code = d.response?.code;
  if (code && code >= 400) return { ok: false, cause: causeFromHttp(code), detail: `HTTP ${code}` };
  if (d.details?.startsWith("keySystem")) return { ok: false, cause: "drm_protected", detail: d.details };
  if (d.type === "networkError") return { ok: false, cause: d.details === "manifestLoadTimeOut" || d.details === "levelLoadTimeOut" ? "timeout" : "network", detail: d.details };
  if (d.type === "mediaError") return { ok: false, cause: "codec_unsupported", detail: d.details };
  return { ok: false, cause: "player_error", detail: d.details };
}

/** Attaches `req` to `video` with the chosen engine. Recovery inside an engine is bounded (one network restart, one media recover, one codec swap). */
export async function startEngine(video: HTMLVideoElement, req: PlayRequest, hooks: Hooks): Promise<Handle> {
  if (req.engine === "hlsjs") {
    const drm: Record<string, unknown> = {};
    if (req.license && (req.license.system === "widevine" || req.license.system === "playready")) drm[KEY_SYSTEMS[req.license.system]] = { licenseUrl: req.license.url };
    const hls = new Hls({ manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 2, emeEnabled: Object.keys(drm).length > 0, drmSystems: drm });
    let networkRestarts = 0;
    let mediaRecoveries = 0;
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR && !(d.response?.code && d.response.code >= 400) && networkRestarts++ < 1) return hls.startLoad(); // transient connection error
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
        if (mediaRecoveries++ === 1) hls.swapAudioCodec();
        return hls.recoverMediaError();
      }
      hooks.onFatal(hlsCause(d));
    });
    hls.loadSource(req.url);
    hls.attachMedia(video);
    return { destroy: () => hls.destroy(), nudge: () => hls.startLoad() };
  }
  if (req.engine === "dashjs") {
    const dash = (await import("dashjs")) as unknown as { MediaPlayer: () => { create: () => DashPlayer }; default?: { MediaPlayer: () => { create: () => DashPlayer } } };
    const player = (dash.MediaPlayer ?? dash.default!.MediaPlayer)().create();
    player.on("error", (e: { error?: { code?: number; message?: string } }) => {
      const m = e.error?.message ?? "";
      hooks.onFatal({ ok: false, cause: /download|http|load/i.test(m) ? "network" : /protect|key|license/i.test(m) ? "drm_protected" : "player_error", detail: m.slice(0, 160) });
    });
    player.initialize(video, req.url, true);
    return { destroy: () => player.destroy() };
  }
  // native: Safari/TV HLS, progressive MP4/TS/WebM
  video.onerror = () => hooks.onFatal({ ok: false, cause: mediaErrorCause(video.error?.code), detail: video.error?.message?.slice(0, 160) });
  video.src = req.url;
  return { destroy: () => { video.onerror = null; video.removeAttribute("src"); video.load(); } };
}
interface DashPlayer {
  on(ev: string, cb: (e: never) => void): void;
  initialize(v: HTMLVideoElement, url: string, autoplay: boolean): void;
  destroy(): void;
}

/**
 * Starts the request on a hidden muted element and resolves only when media really plays: a `playing` event followed by
 * the clock advancing (or a decoded picture). An HTTP 200 alone never counts. Autoplay refusal after the media loaded is
 * reported as `needsGesture` so the UI can show a Play button.
 */
export async function verifiedPlay(req: PlayRequest, timeoutMs = 15_000): Promise<PlayResult> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(video);
  let handle: Handle | undefined;
  const cleanup = () => {
    handle?.destroy();
    video.remove();
  };
  return new Promise<PlayResult>((resolve) => {
    let settled = false;
    let loaded = false;
    const finish = (r: PlayResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      cleanup();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, cause: loaded ? "no_media_data" : "timeout", detail: loaded ? "media loaded but did not start" : "no media data within time limit" }), timeoutMs);
    let startedAt: number | undefined;
    const poll = setInterval(() => {
      if (startedAt !== undefined && (video.currentTime - startedAt >= 0.4 || (video.videoWidth > 0 && video.readyState >= 3 && !video.paused && video.currentTime > startedAt))) finish({ ok: true });
    }, 200);
    video.addEventListener("loadeddata", () => (loaded = true));
    video.addEventListener("playing", () => (startedAt ??= video.currentTime));
    startEngine(video, req, { onFatal: (r) => finish(r) }).then(
      (h) => {
        handle = h;
        if (settled) return cleanup();
        video.play().catch((e: Error) => {
          if (e.name === "NotAllowedError") {
            // Even muted playback was refused: wait for the media to load, then let the user tap Play.
            video.addEventListener("loadeddata", () => finish({ ok: true, needsGesture: true }));
          }
        });
      },
      (e: Error) => finish({ ok: false, cause: "player_error", detail: e.message.slice(0, 160) }),
    );
  });
}

export const SOURCE_KEY = (channelId: string) => `receiver.src.${channelId}`;
export interface CachedSource {
  url: string;
  proxy: string;
  mode: "direct" | "relay";
  engine: "hlsjs" | "native" | "dashjs";
  kind: PlayRequest["kind"];
  origin: string;
  at: number;
}
const RELAY_TTL_MS = 5 * 3600_000; // signed relay links live 6h

export function rememberSource(channelId: string, s: Omit<CachedSource, "at">) {
  try {
    localStorage.setItem(SOURCE_KEY(channelId), JSON.stringify({ ...s, at: Date.now() } satisfies CachedSource));
  } catch {
    /* storage unavailable: the app still works, it just cannot remember */
  }
}
export function recallSource(channelId: string): CachedSource | undefined {
  try {
    const s = JSON.parse(localStorage.getItem(SOURCE_KEY(channelId)) ?? "null") as CachedSource | null;
    if (!s || typeof s.url !== "string") return undefined;
    // A relayed alternate needs its signed link, which expires: drop it rather than replaying a dead link.
    if (s.origin !== "current" && s.mode === "relay" && Date.now() - s.at > RELAY_TTL_MS) return undefined;
    return s;
  } catch {
    return undefined;
  }
}
export function forgetSource(channelId: string) {
  try {
    localStorage.removeItem(SOURCE_KEY(channelId));
  } catch {
    /* ignore */
  }
}

/** Wires the pure repair flow to the real server probes and a real player. */
export async function runRepair(channel: Channel, onUpdate: Parameters<typeof repairAndPlay>[1], signal?: AbortSignal) {
  const caps = await deviceCapabilities();
  const base = typeof location !== "undefined" ? location.protocol === "https:" : false;
  const deps: RepairDeps = {
    capabilities: () => caps,
    diagnose: () => api.diagnose(channel.id),
    findSources: async () => (await api.findSource(channel.id)).candidates,
    play: (req) => verifiedPlay(req),
    pageIsHttps: base,
  };
  return repairAndPlay(deps, onUpdate, signal);
}
