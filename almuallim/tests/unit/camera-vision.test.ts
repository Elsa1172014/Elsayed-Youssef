import { describe, expect, it, vi } from "vitest";
import { classifyCameraError, openCamera, sniffImageType, type MediaDevicesLike } from "@/lib/vision/camera";
import { DEFAULT_STABILITY, StabilityTracker, frameDifference, laplacianVariance, meanBrightness, toGray, type GrayFrame } from "@/lib/vision/stability";

const W = 96, H = 72;
const frame = (fn: (x: number, y: number) => number): GrayFrame => {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = Math.max(0, Math.min(255, fn(x, y)));
  return { width: W, height: H, data };
};
/** Bright "paper" with dark vertical stripes = crisp text-like edges. */
const sharpPage = (shift = 0) => frame((x) => (Math.floor((x + shift) / 2) % 2 === 0 ? 215 : 60));
const blurryPage = () => frame((x) => 140 + 8 * Math.sin(x / 9));
const darkPage = () => frame((x) => (x % 4 < 2 ? 20 : 5));
const noise = (seed: number) => { let s = seed; return frame(() => ((s = (s * 1664525 + 1013904223) >>> 0) >>> 24)); };

describe("image metrics", () => {
  it("laplacian variance separates crisp from blurry from flat", () => {
    expect(laplacianVariance(sharpPage())).toBeGreaterThan(DEFAULT_STABILITY.minSharpness);
    expect(laplacianVariance(blurryPage())).toBeLessThan(DEFAULT_STABILITY.minSharpness);
    expect(laplacianVariance(frame(() => 128))).toBe(0);
  });
  it("frameDifference is 0 for identical frames, large for different ones, 1 for size mismatch", () => {
    expect(frameDifference(sharpPage(), sharpPage())).toBe(0);
    expect(frameDifference(sharpPage(), sharpPage(1))).toBeGreaterThan(0.2);
    expect(frameDifference(sharpPage(), { width: 2, height: 2, data: new Uint8Array(4) })).toBe(1);
  });
  it("converts RGBA to luminance", () => {
    const g = toGray({ width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]) });
    expect([...g.data]).toEqual([255, 0]);
    expect(meanBrightness(g)).toBe(127.5);
  });
});

describe("StabilityTracker", () => {
  it("becomes ready only after N consecutive steady, sharp, well-lit frames", () => {
    const t = new StabilityTracker();
    const states = Array.from({ length: 10 }, () => t.push(sharpPage()));
    const firstReady = states.findIndex((s) => s.ready);
    // frame 0 has no previous frame (diff=1 → moving); frames 1..6 are steady → ready on index 6
    expect(firstReady).toBe(DEFAULT_STABILITY.stableFramesRequired);
    expect(states[firstReady - 1]!.ready).toBe(false);
  });
  it("never fires while the page is moving", () => {
    const t = new StabilityTracker();
    for (let i = 0; i < 30; i++) expect(t.push(sharpPage(i)).ready).toBe(false);
  });
  it("never fires on blurry, dark, or noisy frames and reports why", () => {
    const blur = new StabilityTracker();
    let s = blur.push(blurryPage());
    for (let i = 0; i < 12; i++) s = blur.push(blurryPage());
    expect(s.ready).toBe(false);
    expect(s.issue).toBe("blurry");
    const dark = new StabilityTracker();
    for (let i = 0; i < 12; i++) s = dark.push(darkPage());
    expect(s.issue).toBe("dark");
    const noisy = new StabilityTracker();
    for (let i = 0; i < 12; i++) s = noisy.push(noise(i + 1));
    expect(s.ready).toBe(false);
  });
  it("after a capture stays quiet until the camera moves, then re-arms for the next page", () => {
    const t = new StabilityTracker();
    let s = t.push(sharpPage());
    for (let i = 0; i < 8; i++) s = t.push(sharpPage());
    expect(s.ready).toBe(true);
    t.markCaptured();
    for (let i = 0; i < 20; i++) expect(t.push(sharpPage()).ready).toBe(false); // same page held still
    t.push(sharpPage(1)); // moved
    let ready = false;
    for (let i = 0; i < 10; i++) ready = t.push(sharpPage(1)).ready || ready;
    expect(ready).toBe(true);
  });
});

describe("camera errors and opening", () => {
  it("classifies DOM exceptions", () => {
    const e = (name: string) => ({ name });
    expect(classifyCameraError(e("NotAllowedError"))).toBe("denied");
    expect(classifyCameraError(e("NotFoundError"))).toBe("no-device");
    expect(classifyCameraError(e("NotReadableError"))).toBe("in-use");
    expect(classifyCameraError(e("SecurityError"))).toBe("insecure");
    expect(classifyCameraError(e("TypeError"))).toBe("unsupported");
    expect(classifyCameraError(new Error("x"))).toBe("error");
  });
  it("reports insecure contexts and missing mediaDevices without calling getUserMedia", async () => {
    const md: MediaDevicesLike = { getUserMedia: vi.fn() };
    expect(await openCamera(md, false)).toEqual({ ok: false, status: "insecure" });
    expect(await openCamera(undefined, true)).toEqual({ ok: false, status: "unsupported" });
    expect(md.getUserMedia).not.toHaveBeenCalled();
  });
  it("asks for the rear camera, and on OverconstrainedError retries once with relaxed constraints", async () => {
    const stream = {} as MediaStream;
    const gum = vi.fn().mockRejectedValueOnce({ name: "OverconstrainedError" }).mockResolvedValueOnce(stream);
    const r = await openCamera({ getUserMedia: gum }, true);
    expect(r).toEqual({ ok: true, stream });
    expect(gum.mock.calls[0]![0].video.facingMode).toEqual({ ideal: "environment" });
    expect(gum.mock.calls[1]![0]).toEqual({ audio: false, video: true });
  });
  it("maps a denied permission to a status", async () => {
    const r = await openCamera({ getUserMedia: async () => { throw { name: "NotAllowedError" }; } }, true);
    expect(r).toEqual({ ok: false, status: "denied" });
  });
});

describe("sniffImageType", () => {
  it("detects real formats by magic bytes and rejects everything else", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe("image/jpeg");
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0]))).toBe("image/png");
    expect(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0]))).toBe("image/webp");
    expect(sniffImageType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
  });
});
