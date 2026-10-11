import { describe, expect, it } from "vitest";
import { checkStreamHealth, syncIptvOrg, syncOfficial } from "../src/jobs/catalog";
import { migrate } from "../src/db";
import { alice, makeApp } from "./helpers";

const channels = [
  { id: "A.qa", name: "Al Jazeera", country: "QA", languages: ["ara"], categories: ["news"] },
  { id: "B.us", name: "Kids Club", country: "US", languages: ["eng"], categories: ["kids"] },
];
const streams = [
  { channel: "A.qa", url: "https://a.example/live.m3u8" },
  { channel: "B.us", url: "https://b.example/live.m3u8" },
];
const API = "https://iptv-org.github.io/api";

describe("catalog", () => {
  it("syncs, searches, adds to my channels, and honours takedowns", async () => {
    const { app, store, fetcher } = await makeApp({ [`${API}/channels.json`]: channels, [`${API}/streams.json`]: streams });
    expect(await syncIptvOrg(store, fetcher)).toEqual({ channels: 2 });
    await syncIptvOrg(store, fetcher); // idempotent
    expect((await app.inject({ url: "/v1/catalog?q=jaz", headers: alice })).json()).toHaveLength(1);
    expect((await app.inject({ url: "/v1/catalog?country=us", headers: alice })).json()[0].id).toBe("B.us");
    expect((await app.inject({ url: "/v1/catalog?category=news", headers: alice })).json()[0].id).toBe("A.qa");

    const added = await app.inject({ method: "POST", url: "/v1/catalog/A.qa/add", headers: alice });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ name: "Al Jazeera", streamUrl: "https://a.example/live.m3u8", group: "news" });

    await store.setCatalogStatus("B.us", "blocked");
    expect((await app.inject({ url: "/v1/catalog?q=kids", headers: alice })).json()).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/v1/catalog/B.us/add", headers: alice })).statusCode).toBe(404);
  });

  it("loads the curated official list and rejects invalid entries", async () => {
    const { store } = await makeApp();
    const r = await syncOfficial(store, [
      { id: "x", name: "X", provenance: "official", streams: [{ url: "https://x.example/a.m3u8" }] },
      { id: "y", name: "Y", provenance: "paid", streams: [{ url: "https://y.example/a.m3u8" }] },
    ]);
    expect(r).toEqual({ channels: 1 });
    expect((await store.getCatalogChannel("official:x"))?.provenance).toBe("official");
  });

  it("records stream health and prefers healthy streams when adding", async () => {
    const { app, store, fetcher } = await makeApp({
      [`${API}/channels.json`]: [channels[0]],
      [`${API}/streams.json`]: [{ channel: "A.qa", url: "https://dead.example/a.m3u8" }, { channel: "A.qa", url: "https://ok.example/a.m3u8" }],
      "https://ok.example/a.m3u8": "#EXTM3U\n#EXT-X-VERSION:3\n",
      "https://dead.example/a.m3u8": 404,
    });
    await syncIptvOrg(store, fetcher);
    expect(await checkStreamHealth(store, fetcher)).toEqual({ checked: 2, dead: 1 });
    const added = await app.inject({ method: "POST", url: "/v1/catalog/A.qa/add", headers: alice });
    expect(added.json().streamUrl).toBe("https://ok.example/a.m3u8");
  });
});

describe("migrations", () => {
  it("are idempotent", async () => {
    const { db } = await makeApp();
    expect(await migrate(db)).toEqual([]);
  });
});
