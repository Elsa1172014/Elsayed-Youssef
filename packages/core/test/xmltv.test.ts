import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, parseXmltv, parseXmltvTime } from "../src";

describe("parseXmltvTime", () => {
  it("converts offsets to UTC", () => {
    expect(parseXmltvTime("20261011183000 +0300")).toBe("2026-10-11T15:30:00.000Z");
    expect(parseXmltvTime("20261011183000")).toBe("2026-10-11T18:30:00.000Z");
    expect(parseXmltvTime("garbage")).toBeNull();
  });
});

describe("parseXmltv", () => {
  const xml = `<?xml version="1.0"?><tv>
  <channel id="aj.qa"><display-name>Al Jazeera</display-name><display-name>الجزيرة</display-name><icon src="https://e.org/a.png"/></channel>
  <programme start="20261011180000 +0000" stop="20261011190000 +0000" channel="aj.qa">
    <title lang="ar">نشرة &amp; أخبار</title><desc>وصف</desc><category>News</category></programme>
  <programme start="bad" stop="20261011190000 +0000" channel="aj.qa"><title>x</title></programme>
  <programme start="20261011190000 +0000" stop="20261011180000 +0000" channel="aj.qa"><title>reversed</title></programme>
  </tv>`;
  it("parses channels and programmes and skips bad ones", () => {
    const r = parseXmltv(xml);
    expect(r.channels[0]).toMatchObject({ id: "aj.qa", displayNames: ["Al Jazeera", "الجزيرة"], icon: "https://e.org/a.png" });
    expect(r.programmes).toHaveLength(1);
    expect(r.programmes[0]).toMatchObject({ title: "نشرة & أخبار", lang: "ar", category: "News", start: "2026-10-11T18:00:00.000Z" });
    expect(r.warnings).toHaveLength(2);
  });
});

describe("assertPublicHttpUrl", () => {
  it("accepts public http(s)", () => {
    expect(assertPublicHttpUrl("https://example.org/a.m3u").hostname).toBe("example.org");
  });
  it.each([
    "file:///etc/passwd", "http://localhost/x", "http://127.0.0.1/x", "http://10.0.0.5/x", "http://192.168.1.1/x",
    "http://169.254.169.254/latest", "http://[::1]/x", "https://u:p@example.org/x", "http://printer.local/x", "nope",
  ])("rejects %s", (u) => {
    expect(() => assertPublicHttpUrl(u)).toThrow();
  });
});
