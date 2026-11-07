import { describe, expect, it } from "vitest";
import type { TextModel } from "../src/ai";
import type { SafeOpen } from "../src/safeFetch";
import { parseMedia, pickSegment, pickVariant } from "../src/subtitles/hls";
import { extractTsAudio } from "../src/subtitles/tsAudio";
import { alice, makeApp } from "./helpers";

/** Builds a minimal valid MPEG-TS: PAT → PMT (one audio PID of `type`) → PES packets carrying `audio`. */
function buildTs(audio: Buffer, type = 0x0f, opts: { scrambled?: boolean } = {}): Buffer {
  const pkt = (pid: number, pusi: boolean, payload: Buffer, cc: number, scrambled = false) => {
    const b = Buffer.alloc(188, 0xff);
    b[0] = 0x47; b[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f); b[2] = pid & 0xff;
    const room = 184;
    if (payload.length < room) {
      // adaptation field stuffing so the payload ends the packet exactly
      const afLen = room - payload.length - 1;
      b[3] = (scrambled ? 0x80 : 0) | 0x30 | (cc & 0x0f); b[4] = afLen;
      if (afLen > 0) { b[5] = 0x00; b.fill(0xff, 6, 5 + afLen); }
      payload.copy(b, 5 + afLen);
    } else { b[3] = (scrambled ? 0x80 : 0) | 0x10 | (cc & 0x0f); payload.copy(b, 4, 0, room); }
    return b;
  };
  const pat = Buffer.from([0x00, 0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xf0, 0x00, 0, 0, 0, 0]);
  const pmtBody = [0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x01, 0xf0, 0x00, type, 0xe1, 0x01, 0xf0, 0x00, 0, 0, 0, 0];
  const pmt = Buffer.from([0x00, ...pmtBody]);
  const pesHeader = Buffer.from([0, 0, 1, 0xc0, 0, 0, 0x80, 0x80, 0x05, 0x21, 0, 1, 0, 1]);
  const pes = Buffer.concat([pesHeader, audio]);
  const out = [pkt(0, true, pat, 0), pkt(0x1000, true, pmt, 0)];
  for (let off = 0, cc = 0; off < pes.length; off += 184, cc++) out.push(pkt(0x101, off === 0, pes.subarray(off, off + 184), cc, opts.scrambled));
  return Buffer.concat(out);
}

describe("MPEG-TS audio extraction", () => {
  const aac = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) & 0xff));
  it("recovers the AAC elementary stream byte-for-byte", () => {
    const r = extractTsAudio(buildTs(aac));
    expect(r?.mime).toBe("audio/aac");
    expect(r?.data.equals(aac)).toBe(true);
  });
  it("labels MPEG audio as audio/mpeg and skips unsupported (AC-3) or scrambled audio", () => {
    expect(extractTsAudio(buildTs(aac, 0x03))?.mime).toBe("audio/mpeg");
    expect(extractTsAudio(buildTs(aac, 0x81))).toBeUndefined();
    expect(extractTsAudio(buildTs(aac, 0x0f, { scrambled: true }))).toBeUndefined();
    expect(extractTsAudio(Buffer.from("not a ts"))).toBeUndefined();
  });
});

describe("HLS segment picking", () => {
  const media = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:100\n" + [0, 1, 2, 3, 4, 5].map((i) => `#EXTINF:6.0,\nseg${100 + i}.ts`).join("\n");
  it("starts ~3 segments behind live, then follows on without gaps", () => {
    const p = parseMedia(media, "https://cdn.example.org/live/index.m3u8");
    expect(pickSegment(p)?.seq).toBe(102);
    expect(pickSegment(p, 102)).toMatchObject({ seq: 103, url: "https://cdn.example.org/live/seg103.ts", duration: 6 });
    expect(pickSegment(p, 105)).toBeUndefined(); // not published yet
    expect(pickSegment(p, 50)?.seq).toBe(102); // fell behind: jump back near live
  });
  it("picks the lowest-bandwidth variant and flags encryption", () => {
    expect(pickVariant("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nhi.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=400000\nlo.m3u8", "https://x.org/a/master.m3u8")).toBe("https://x.org/a/lo.m3u8");
    expect(parseMedia('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:6,\na.ts', "https://x.org/").encrypted).toBe(true);
  });
});

describe("server-side live subtitles endpoint", () => {
  const aac = Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 13) & 0xff));
  const files: Record<string, Buffer | string> = {
    "https://cdn.example.org/live/master.m3u8": "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nhi.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=300000\nlo.m3u8",
    "https://cdn.example.org/live/lo.m3u8": "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:7\n" + [0, 1, 2, 3, 4].map((i) => `#EXTINF:6.0,\ns${7 + i}.ts`).join("\n"),
    "https://cdn.example.org/drm/index.m3u8": '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:6,\na.ts',
  };
  for (let i = 7; i < 12; i++) files[`https://cdn.example.org/live/s${i}.ts`] = buildTs(aac);
  const opener: SafeOpen = async (url) => {
    const f = files[url];
    if (f === undefined) return { status: 404, headers: new Headers(), body: null, url };
    const bytes = typeof f === "string" ? new TextEncoder().encode(f) : new Uint8Array(f);
    return { status: 200, headers: new Headers(), body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), url };
  };
  const heard: { mime: string; bytes: number }[] = [];
  const model: TextModel = { complete: async () => "", listen: async (_s, b64, mime) => { heard.push({ mime, bytes: Buffer.from(b64, "base64").length }); return "مرحبًا بكم في نشرة الأخبار"; } };
  const add = async (app: Awaited<ReturnType<typeof makeApp>>["app"], url: string) =>
    (await app.inject({ method: "POST", url: "/v1/me/channels", headers: alice, payload: { name: "News", streamUrl: url } })).json().id as string;

  it("subtitles the segment being watched and then the next one (works for any device)", async () => {
    const { app } = await makeApp({}, { opener, model });
    const id = await add(app, "https://cdn.example.org/live/master.m3u8");
    const first = (await app.inject({ method: "POST", url: `/v1/me/channels/${id}/subtitle-live`, headers: alice, payload: {} })).json();
    expect(first).toMatchObject({ text: "مرحبًا بكم في نشرة الأخبار", seq: 8, duration: 6 });
    expect(heard.at(-1)).toEqual({ mime: "audio/aac", bytes: aac.length }); // only the audio track is sent
    const next = (await app.inject({ method: "POST", url: `/v1/me/channels/${id}/subtitle-live`, headers: alice, payload: { after: 8 } })).json();
    expect(next.seq).toBe(9);
  });

  it("refuses encrypted/DRM streams and non-HLS sources with a client fallback hint", async () => {
    const { app } = await makeApp({}, { opener, model });
    const drm = await add(app, "https://cdn.example.org/drm/index.m3u8");
    const r = await app.inject({ method: "POST", url: `/v1/me/channels/${drm}/subtitle-live`, headers: alice, payload: {} });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ fallback: "client", error: expect.stringContaining("encrypted") });
    const gone = await add(app, "https://cdn.example.org/missing.m3u8");
    expect((await app.inject({ method: "POST", url: `/v1/me/channels/${gone}/subtitle-live`, headers: alice, payload: {} })).statusCode).toBe(422);
    const noModel = await makeApp({}, { opener });
    const c = await add(noModel.app, "https://cdn.example.org/live/master.m3u8");
    expect((await noModel.app.inject({ method: "POST", url: `/v1/me/channels/${c}/subtitle-live`, headers: alice, payload: {} })).statusCode).toBe(503);
  });
});
