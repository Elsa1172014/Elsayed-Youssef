/**
 * Frame stability / sharpness analysis on small grayscale frames. Pure functions + a small state machine,
 * so the logic is unit-tested without a camera. The browser feeds it frames downscaled to ~96×72.
 *
 * NOTE: thresholds are uncalibrated defaults — tune on real devices (phones vs laptop webcams differ a lot).
 */

export interface GrayFrame {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray; // 1 byte per pixel, row-major
}

/** RGBA ImageData-like → luminance frame. */
export function toGray(rgba: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }): GrayFrame {
  const n = rgba.width * rgba.height;
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (rgba.data[j]! * 299 + rgba.data[j + 1]! * 587 + rgba.data[j + 2]! * 114) / 1000;
  }
  return { width: rgba.width, height: rgba.height, data: out };
}

/** Mean absolute pixel difference between two same-size frames, 0..1. */
export function frameDifference(a: GrayFrame, b: GrayFrame): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i]! - b.data[i]!);
  return sum / (a.data.length * 255);
}

export function meanBrightness(f: GrayFrame): number {
  let s = 0;
  for (let i = 0; i < f.data.length; i++) s += f.data[i]!;
  return s / f.data.length;
}

/** Variance of the 4-neighbour Laplacian: high for crisp edges (printed text), low for blur or blank. */
export function laplacianVariance(f: GrayFrame): number {
  const { width: w, height: h, data: d } = f;
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = d[i - w]! + d[i + w]! + d[i - 1]! + d[i + 1]! - 4 * d[i]!;
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export interface StabilityConfig {
  stableFramesRequired: number; // consecutive steady frames before "ready"
  maxDiff: number;              // frame-to-frame difference below this counts as steady
  moveDiff: number;             // difference above this re-arms auto-capture after a capture
  minSharpness: number;         // Laplacian variance floor
  minBrightness: number;
  maxBrightness: number;
}

export const DEFAULT_STABILITY: StabilityConfig = {
  stableFramesRequired: 6,
  maxDiff: 0.012,
  moveDiff: 0.05,
  minSharpness: 120,
  minBrightness: 45,
  maxBrightness: 235,
};

export type StabilityIssue = "moving" | "blurry" | "dark" | "bright" | "warming_up";

export interface StabilityState {
  diff: number;
  sharpness: number;
  brightness: number;
  stableFrames: number;
  ready: boolean;       // steady + sharp + well lit AND armed: capture now
  issue: StabilityIssue | null;
}

/**
 * Feed frames with `push`. `ready` becomes true once, after N steady/sharp frames; after `markCaptured()`
 * the tracker stays quiet until the camera moves (so the same page isn't re-sent repeatedly).
 */
export class StabilityTracker {
  private prev: GrayFrame | null = null;
  private stable = 0;
  private armed = true;

  constructor(private readonly cfg: StabilityConfig = DEFAULT_STABILITY) {}

  markCaptured() {
    this.armed = false;
    this.stable = 0;
  }

  reset() {
    this.prev = null;
    this.stable = 0;
    this.armed = true;
  }

  push(frame: GrayFrame): StabilityState {
    const c = this.cfg;
    const diff = this.prev ? frameDifference(this.prev, frame) : 1;
    this.prev = frame;
    const brightness = meanBrightness(frame);
    const sharpness = laplacianVariance(frame);

    if (!this.armed && diff >= c.moveDiff) this.armed = true;

    let issue: StabilityIssue | null = null;
    if (brightness < c.minBrightness) issue = "dark";
    else if (brightness > c.maxBrightness) issue = "bright";
    else if (diff > c.maxDiff) issue = "moving";
    else if (sharpness < c.minSharpness) issue = "blurry";

    if (issue === null) this.stable++;
    else this.stable = 0;

    const ready = this.armed && this.stable >= c.stableFramesRequired;
    return { diff, sharpness, brightness, stableFrames: this.stable, ready, issue: issue ?? (ready ? null : this.stable === 0 ? "warming_up" : null) };
  }
}

export const ISSUE_MESSAGE_AR: Record<StabilityIssue, string> = {
  moving: "ثبّت الكاميرا قليلًا",
  blurry: "الصورة غير واضحة؛ قرّب الصفحة أو اضبط التركيز",
  dark: "الإضاءة ضعيفة؛ اقترب من مصدر ضوء",
  bright: "الإضاءة قوية جدًا؛ تجنّب الانعكاس",
  warming_up: "جارٍ تحليل الصورة…",
};
