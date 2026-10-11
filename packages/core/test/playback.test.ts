import { describe, expect, it } from "vitest";
import { backoffDelay, causeFromHttp, declaredCodecs, detectProtection, detectStreamKind, firstSegmentUrl, firstVariantUrl, identityName, looksLikeMedia, sameChannel, withRetry, type Cause } from "../src";

describe("stream type", () => {
  it("prefers content type and body over the URL extension", () => {
    expect(detectStreamKind("http://x/a", "application/vnd.apple.mpegurl")).toBe("hls");
    expect(detectStreamKind("http://x/a", "", "#EXTM3U\n")).toBe("hls");
    expect(detectStreamKind("http://x/a", "application/dash+xml")).toBe("dash");
    expect(detectStreamKind("http://x/a.m3u8?t=1", "")).toBe("hls");
    expect(detectStreamKind("http://x/live.ts", "")).toBe("ts");
    expect(detectStreamKind("http://x/a", "text/html; charset=utf-8")).toBe("html");
    expect(detectStreamKind("http://x/a", "")).toBe("unknown");
  });
});

describe("protection detection", () => {
  it("separates plain AES-128 from DRM", () => {
    const aes = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin"\n#EXTINF:4,\ns.ts';
    expect(detectProtection(aes)).toEqual({ drm: [], encrypted: true, licenseUrls: [] });
    expect(detectProtection("#EXTM3U\n#EXTINF:4,\ns.ts").encrypted).toBe(false);
  });
  it("finds FairPlay and Widevine in HLS and all systems in DASH", () => {
    const fp = '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"';
    expect(detectProtection(fp).drm).toEqual(["fairplay"]);
    const mpd = `<MPD><ContentProtection schemeIdUri="urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED"/>
      <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"><mspr:laurl>https://lic.example/pr</mspr:laurl></ContentProtection></MPD>`;
    const p = detectProtection(mpd);
    expect(p.drm.sort()).toEqual(["playready", "widevine"]);
    expect(p.licenseUrls).toEqual(["https://lic.example/pr"]);
  });
  it("reads declared codecs", () => {
    expect(declaredCodecs('#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.4d401f,mp4a.40.2"\nv.m3u8')).toEqual(["avc1.4d401f", "mp4a.40.2"]);
  });
});

describe("failure classification", () => {
  it("maps HTTP statuses to causes", () => {
    const m: [number, Cause][] = [[200, "none"], [401, "auth_required"], [403, "forbidden"], [451, "geo_blocked"], [404, "gone"], [429, "rate_limited"], [503, "server_error"]];
    for (const [s, c] of m) expect(causeFromHttp(s)).toBe(c);
  });
  it("recognises real media bytes only", () => {
    const ts = new Uint8Array(400); ts[0] = 0x47; ts[188] = 0x47;
    expect(looksLikeMedia(ts)).toBe(true);
    const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]);
    expect(looksLikeMedia(mp4)).toBe(true);
    expect(looksLikeMedia(new TextEncoder().encode("<html><body>Not found</body></html>"))).toBe(false);
    expect(looksLikeMedia(new Uint8Array(3))).toBe(false);
  });
  it("walks master -> variant -> segment", () => {
    const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/i.m3u8\n";
    expect(firstVariantUrl(master, "http://h/live/m.m3u8")).toBe("http://h/live/low/i.m3u8");
    expect(firstVariantUrl("#EXTM3U\n#EXTINF:4,\ns.ts", "http://h/m.m3u8")).toBeUndefined();
    expect(firstSegmentUrl("#EXTM3U\n#EXTINF:4,\ns1.ts\n", "http://h/live/low/i.m3u8")).toBe("http://h/live/low/s1.ts");
    expect(firstSegmentUrl('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\ns1.m4s', "http://h/a/i.m3u8")).toBe("http://h/a/init.mp4");
  });
});

describe("strict channel identity", () => {
  it("ignores quality markers but never merges different channels", () => {
    expect(identityName("beIN SPORTS 1 HD [Not 24/7]")).toBe("bein sports 1");
    expect(sameChannel({ name: "beIN SPORTS 1 HD" }, { name: "BeIN Sports 1 (1080p)" })).toBe(true);
    expect(sameChannel({ name: "beIN SPORTS 1" }, { name: "beIN SPORTS 2" })).toBe(false);
    expect(sameChannel({ name: "beIN SPORTS 1" }, { name: "beIN SPORTS News" })).toBe(false);
    expect(sameChannel({ name: "Sky News" }, { name: "Sky News Arabia" })).toBe(false);
  });
  it("official ids decide first, then country and language must agree", () => {
    expect(sameChannel({ officialId: "AlJazeera.qa@SD", name: "A" }, { officialId: "aljazeera.qa", name: "B" })).toBe(true);
    expect(sameChannel({ officialId: "x.qa", name: "Same" }, { officialId: "y.qa", name: "Same" })).toBe(false);
    expect(sameChannel({ name: "Channel 5", country: "GB" }, { name: "Channel 5", country: "DE" })).toBe(false);
    expect(sameChannel({ name: "Kids", languages: ["ara"] }, { name: "Kids", languages: ["eng"] })).toBe(false);
    expect(sameChannel({ name: "Kids", languages: ["ara", "eng"] }, { name: "Kids", languages: ["eng"] })).toBe(true);
    expect(sameChannel({ name: "Kids", country: "AE" }, { name: "Kids" })).toBe(true);
  });
});

describe("bounded retry", () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  it("retries only retryable causes, with exponential, capped delays, and stops at the limit", async () => {
    sleeps.length = 0;
    let n = 0;
    const r = await withRetry(async () => ({ ok: false, cause: "timeout" as Cause, n: ++n }), { attempts: 4, baseDelayMs: 100, maxDelayMs: 250 }, sleep);
    expect(r.n).toBe(4);
    expect(sleeps).toEqual([100, 200, 250]);
    expect(backoffDelay({ attempts: 9, baseDelayMs: 100, maxDelayMs: 250 }, 5)).toBe(250);
  });
  it("does not retry refusals and returns on first success", async () => {
    let n = 0;
    await withRetry(async () => ({ ok: false, cause: "forbidden" as Cause, n: ++n }), undefined, sleep);
    expect(n).toBe(1);
    n = 0;
    const r = await withRetry(async () => ({ ok: ++n === 2, cause: "network" as Cause }), undefined, sleep);
    expect(r.ok).toBe(true);
    expect(n).toBe(2);
  });
});
