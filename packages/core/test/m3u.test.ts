import { describe, expect, it } from "vitest";
import { parseM3U, serializeM3U } from "../src";

describe("parseM3U", () => {
  it("parses attributes, names and header guide URL", () => {
    const r = parseM3U(
      `#EXTM3U url-tvg="https://example.org/guide.xml"
#EXTINF:-1 tvg-id="AlJazeera.qa" tvg-logo="https://example.org/aj.png" group-title="News",Al Jazeera
https://example.org/aj.m3u8
`,
    );
    expect(r.warnings).toEqual([]);
    expect(r.epgUrls).toEqual(["https://example.org/guide.xml"]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({
      name: "Al Jazeera",
      tvgId: "AlJazeera.qa",
      groupTitle: "News",
      duration: -1,
      url: "https://example.org/aj.m3u8",
    });
  });

  it("keeps commas inside quoted attributes and Arabic names", () => {
    const r = parseM3U(`#EXTINF:-1 group-title="News, World",الجزيرة\nhttps://e.org/a.m3u8`);
    expect(r.entries[0]).toMatchObject({ name: "الجزيرة", groupTitle: "News, World" });
  });

  it("handles BOM, CRLF, blank lines, #EXTGRP and ignored directives", () => {
    const r = parseM3U(
      "﻿#EXTM3U\r\n\r\n#EXTINF:-1,Chan\r\n#EXTGRP:Sports\r\n#EXTVLCOPT:http-user-agent=x\r\nhttp://e.org/s\r\n",
    );
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.groupTitle).toBe("Sports");
  });

  it("warns instead of throwing on malformed input", () => {
    const r = parseM3U(`https://e.org/orphan\n#EXTINF:abc,Bad\nhttps://e.org/x\n#EXTINF:-1,Dangling`);
    expect(r.entries).toHaveLength(0);
    expect(r.warnings.map((w) => w.line)).toEqual([1, 2, 3, 4]);
  });

  it("rejects non-streaming URL schemes", () => {
    const r = parseM3U(`#EXTINF:-1,A\njavascript:alert(1)\n#EXTINF:-1,B\nfile:///etc/passwd\n#EXTINF:-1,C\nhttps://ok.example/c.m3u8`);
    expect(r.entries.map((e) => e.name)).toEqual(["C"]);
    expect(r.warnings).toHaveLength(2);
  });

  it("falls back to tvg-name when the display name is empty", () => {
    const r = parseM3U(`#EXTINF:-1 tvg-name="Fallback",\nhttps://e.org/f`);
    expect(r.entries[0]!.name).toBe("Fallback");
  });
});

describe("serializeM3U", () => {
  it("round-trips user edits", () => {
    const src = parseM3U(`#EXTM3U\n#EXTINF:-1 tvg-id="x" group-title="G",Name\nhttps://e.org/x.m3u8`);
    const edited = src.entries.map((e) => ({ ...e, name: "Renamed", groupTitle: "Mine" }));
    const again = parseM3U(serializeM3U(edited));
    expect(again.entries[0]).toMatchObject({ name: "Renamed", groupTitle: "Mine", tvgId: "x" });
  });
});
