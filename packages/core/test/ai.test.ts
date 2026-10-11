import { describe, expect, it } from "vitest";
import { normalizeText, recommend, searchChannels, suggestEpgMappings } from "../src";

const chans = [
  { id: "1", name: "Al Jazeera", group: "News" },
  { id: "2", name: "الجزيرة مباشر", group: "أخبار" },
  { id: "3", name: "Sky News Arabia", group: "News" },
  { id: "4", name: "Cartoon Kids", group: "Kids" },
  { id: "5", name: "Hidden News", group: "News", hidden: true },
];

describe("normalizeText", () => {
  it("unifies Arabic variants and strips diacritics", () => {
    expect(normalizeText("أَخْبَار")).toBe("اخبار");
    expect(normalizeText("القاهرة")).toBe(normalizeText("القاهره"));
    expect(normalizeText("٢٤ News!")).toBe("24 news");
  });
});

describe("searchChannels", () => {
  it("finds Arabic channel by Latin query and vice versa", () => {
    expect(searchChannels("jazeera", chans)[0]?.id).toBe("1");
    const ar = searchChannels("الجزيرة", chans).map((h) => h.id);
    expect(ar).toContain("2");
    expect(ar).toContain("1");
  });
  it("matches what is on now and skips hidden channels", () => {
    const hits = searchChannels("football", chans, { "4": { title: "Football Highlights" } });
    expect(hits[0]?.id).toBe("4");
    expect(searchChannels("hidden", chans)).toEqual([]);
  });
  it("only returns ids from the supplied catalog", () => {
    const ids = new Set(chans.map((c) => c.id));
    for (const h of searchChannels("news", chans)) expect(ids.has(h.id)).toBe(true);
  });
  it("handles empty queries", () => {
    expect(searchChannels("  !! ", chans)).toEqual([]);
  });
});

describe("recommend", () => {
  it("prefers unwatched channels sharing group/name tokens with history", () => {
    const recs = recommend(chans, [{ channelId: "1", seconds: 3600 }]);
    expect(recs[0]?.id).toBe("3");
    expect(recs.map((r) => r.id)).not.toContain("1");
    expect(recs.map((r) => r.id)).not.toContain("5");
  });
  it("returns nothing without history", () => {
    expect(recommend(chans, [])).toEqual([]);
  });
});

describe("suggestEpgMappings", () => {
  it("suggests close names, skips mapped channels and weak matches", () => {
    const guide = [
      { id: "aj.qa", displayNames: ["Al Jazeera"] },
      { id: "sky.ar", displayNames: ["Sky News Arabia HD"] },
    ];
    const s = suggestEpgMappings([...chans.slice(0, 4), { id: "9", name: "Al Jazeera", epgChannelId: "x" }], guide);
    expect(s.find((x) => x.channelId === "1")?.epgChannelId).toBe("aj.qa");
    expect(s.find((x) => x.channelId === "3")?.epgChannelId).toBe("sky.ar");
    expect(s.find((x) => x.channelId === "4")).toBeUndefined();
    expect(s.find((x) => x.channelId === "9")).toBeUndefined();
  });
});
