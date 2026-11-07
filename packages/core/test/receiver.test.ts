import { describe, expect, it } from "vitest";
import { parseHdHomeRunLineup, parseOpenWebifServices, receiverEndpoint } from "../src";

describe("receiver APIs", () => {
  it("routes a receiver URL to its official API", () => {
    expect(receiverEndpoint("https://tv.example.org/lineup.json")).toEqual({ kind: "hdhomerun", url: "https://tv.example.org/lineup.json" });
    expect(receiverEndpoint("https://box.example.org").kind).toBe("enigma2");
    expect(receiverEndpoint("https://box.example.org").url).toBe("https://box.example.org/api/getallservices");
  });

  it("parses an HDHomeRun lineup and skips copy-protected channels", () => {
    const ch = parseHdHomeRunLineup([
      { GuideNumber: "2.1", GuideName: "Free Channel", URL: "http://10.0.0.5:5004/auto/v2.1" },
      { GuideNumber: "5.1", GuideName: "Protected", URL: "http://10.0.0.5:5004/auto/v5.1", DRM: 1 },
      { GuideName: "", URL: "x" },
    ]);
    expect(ch).toEqual([{ name: "Free Channel", url: "http://10.0.0.5:5004/auto/v2.1", number: "2.1", group: "HDHomeRun" }]);
    expect(parseHdHomeRunLineup({})).toEqual([]);
  });

  it("parses OpenWebif bouquets into playable services only", () => {
    const ch = parseOpenWebifServices({ services: [{ servicename: "Favourites", subservices: [
      { servicename: "News", servicereference: "1:64:1:0:0:0:0:0:0:0:" },
      { servicename: "Channel A", servicereference: "1:0:19:1:2:3:4:0:0:0:" },
      { servicename: "Channel A", servicereference: "1:0:19:1:2:3:4:0:0:0:" },
    ] }] }, "https://box.example.org");
    expect(ch).toEqual([{ name: "Channel A", url: "https://box.example.org:8001/1:0:19:1:2:3:4:0:0:0:", group: "Favourites" }]);
  });
});
