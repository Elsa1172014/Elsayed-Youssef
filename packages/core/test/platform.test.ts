import { describe, expect, it } from "vitest";
import {
  cosine, fillCredentials, fuseRankings, hashingEmbedder, mapIptvOrg, mergeProgrammes, nearest, parseOfficialList,
  parseXtreamLive, probeStream, rankStreams, xtreamApiUrl, xtreamAuthOk, xtreamStreamTemplate, type FetchLike,
} from "../src";

describe("xtream", () => {
  it("builds API urls and keeps credentials out of stored stream templates", () => {
    expect(xtreamApiUrl({ baseUrl: "https://p.example:8080", username: "u", password: "p w" }, "get_live_streams"))
      .toBe("https://p.example:8080/player_api.php?username=u&password=p+w&action=get_live_streams");
    const t = xtreamStreamTemplate("https://p.example:8080/x", 42);
    expect(t).toBe("https://p.example:8080/live/{username}/{password}/42.m3u8");
    expect(fillCredentials(t, { username: "u", password: "p/w" })).toBe("https://p.example:8080/live/u/p%2Fw/42.m3u8");
  });
  it("parses live streams and auth state", () => {
    const ch = parseXtreamLive([{ category_id: "1", category_name: "News" }], [
      { stream_id: 7, name: "A", category_id: "1", stream_icon: "https://e.org/i.png", epg_channel_id: "a.x" },
      { stream_id: "bad", name: "B" },
    ]);
    expect(ch).toEqual([{ streamId: 7, name: "A", categoryName: "News", logo: "https://e.org/i.png", epgChannelId: "a.x" }]);
    expect(xtreamAuthOk({ user_info: { auth: 1, status: "Active" } })).toBe(true);
    expect(xtreamAuthOk({ user_info: { auth: 1, status: "Expired" } })).toBe(false);
    expect(xtreamAuthOk(null)).toBe(false);
  });
});

describe("catalog", () => {
  it("maps iptv-org data, skipping nsfw/closed/blocked/adult and header-dependent streams", () => {
    const channels = [
      { id: "A.qa", name: "A", country: "QA", categories: ["news"], website: "https://a.example" },
      { id: "B.xx", name: "B", is_nsfw: true },
      { id: "C.xx", name: "C", closed: "2020-01-01" },
      { id: "D.xx", name: "D" },
      { id: "E.xx", name: "E" },
      { id: "F.xx", name: "F", categories: ["xxx"] },
      { id: "G.xx", name: "G" },
    ];
    const streams = [
      { channel: "A.qa", url: "https://a.example/live.m3u8", quality: "720p" },
      { channel: "A.qa", url: "https://a.example/live.m3u8" },
      { channel: "A.qa", url: "javascript:alert(1)" },
      { channel: "A.qa", url: "rtmp://a.example/live" },
      { channel: "B.xx", url: "https://b.example/x.m3u8" },
      { channel: "C.xx", url: "https://c.example/x.m3u8" },
      { channel: "E.xx", url: "https://e.example/x.m3u8", referrer: "https://spoof" },
      { channel: "F.xx", url: "https://f.example/x.m3u8" },
      { channel: "G.xx", url: "https://g.example/x.m3u8" },
      { channel: null, title: "Unlinked", url: "https://u.example/x.m3u8" },
    ];
    const r = mapIptvOrg(channels, streams, {
      logos: [
        { channel: "A.qa", url: "https://a.example/small.png", in_use: true, width: 50 },
        { channel: "A.qa", url: "https://a.example/logo.png", in_use: true, width: 300 },
        { channel: "A.qa", url: "https://a.example/old.png", in_use: false, width: 900 },
      ],
      feeds: [{ channel: "A.qa", languages: ["ara"] }, { channel: "A.qa", languages: ["eng", "ara"] }],
      blocklist: [{ channel: "G.xx", reason: "dmca" }],
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: "A.qa", provenance: "directory", logoUrl: "https://a.example/logo.png", languages: ["ara", "eng"] });
    expect(r[0]!.streams).toEqual([{ url: "https://a.example/live.m3u8", quality: "720p" }]);
    expect(mapIptvOrg(null, null)).toEqual([]);
  });
  it("only accepts valid curated official entries", () => {
    const r = parseOfficialList([
      { id: "x", name: "X", provenance: "official", streams: [{ url: "https://x.example/a.m3u8" }] },
      { id: "y", name: "Y", provenance: "paid", streams: [{ url: "https://y.example/a.m3u8" }] },
      { id: "z", name: "Z", provenance: "fast", streams: [] },
    ]);
    expect(r.map((c) => c.id)).toEqual(["official:x"]);
  });
});

describe("health", () => {
  const mk = (ok: boolean, status: number, body = ""): FetchLike => async () => ({ ok, status, text: async () => body });
  it("classifies streams", async () => {
    expect((await probeStream("https://e.org/a.m3u8", mk(true, 200, "#EXTM3U\n"))).status).toBe("ok");
    expect((await probeStream("https://e.org/a.m3u8", mk(true, 200, "<html>"))).status).toBe("dead");
    expect((await probeStream("https://e.org/a.m3u8", mk(false, 404))).reason).toBe("HTTP 404");
    const boom: FetchLike = async () => { throw new Error("x"); };
    expect((await probeStream("https://e.org/a.m3u8", boom)).status).toBe("dead");
  });
  it("ranks healthy and fast streams first", () => {
    const r = rankStreams([
      { id: 1, status: "dead" as const }, { id: 2, status: "ok" as const, latencyMs: 300 },
      { id: 3, status: "unknown" as const }, { id: 4, status: "ok" as const, latencyMs: 100 },
    ]);
    expect(r.map((x) => x.id)).toEqual([4, 2, 3, 1]);
  });
});

describe("epg merge", () => {
  it("prefers high-priority sources and fills gaps from lower ones", () => {
    const p = (title: string, s: string, e: string, priority: number) => ({ channelId: "c", title, start: `2026-10-11T${s}:00.000Z`, stop: `2026-10-11T${e}:00.000Z`, priority });
    const merged = mergeProgrammes([p("low-1800", "18:00", "19:00", 1), p("hi-1800", "18:00", "18:30", 5), p("low-1900", "19:00", "20:00", 1)]);
    expect(merged.map((m) => m.title)).toEqual(["hi-1800", "low-1900"]);
  });
});

describe("embeddings", () => {
  const e = hashingEmbedder();
  it("is deterministic, unit length and spelling-aware", () => {
    expect(e.embed("Al Jazeera")).toEqual(e.embed("al  jazeera!"));
    expect(cosine(e.embed("Al Jazeera"), e.embed("Al Jazeera"))).toBeCloseTo(1, 5);
    expect(cosine(e.embed("Sky News Arabia"), e.embed("Sky News"))).toBeGreaterThan(cosine(e.embed("Sky News Arabia"), e.embed("Cartoon Kids")));
  });
  it("finds nearest items and fuses rankings", () => {
    const items = ["Sky News Arabia", "Cartoon Kids", "Al Jazeera"].map((n) => ({ id: n, vector: e.embed(n) }));
    expect(nearest(e.embed("skynews"), items)[0]?.id).toBe("Sky News Arabia");
    expect(fuseRankings([["a", "b"], ["b", "c"]])[0]).toBe("b");
  });
});
