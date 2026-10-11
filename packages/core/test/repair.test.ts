import { describe, expect, it } from "vitest";
import { repairAndPlay, type Candidate, type Capabilities, type Diagnosis, type PanelState, type PlayRequest, type PlayResult, type RepairDeps } from "../src";

const clear = { drm: [], encrypted: false, licenseUrls: [] };
const diag = (over: Partial<Diagnosis> = {}): Diagnosis => ({ ok: true, url: "https://o.example/a.m3u8", proxy: "/v1/proxy?a", kind: "hls", cause: "none", codecs: [], protection: clear, steps: [], ...over });
const caps = (over: Partial<Capabilities> = {}): Capabilities => ({ hls: "both", dash: false, codec: () => true, drm: [], ...over });
const cand = (url: string, origin: Candidate["origin"] = "catalog"): Candidate => ({ name: "Chan", url, proxy: `/v1/proxy?${url}`, origin, diagnosis: diag({ url, proxy: `/v1/proxy?${url}` }) });

function run(over: Partial<RepairDeps> & { plays?: (req: PlayRequest, url: string) => PlayResult }) {
  const calls: { url: string; mode: string; engine: string }[] = [];
  const updates: PanelState[] = [];
  const deps: RepairDeps = {
    capabilities: () => caps(),
    diagnose: async () => diag(),
    findSources: async () => [],
    pageIsHttps: true,
    sleep: async () => undefined,
    play: async (req, src) => {
      calls.push({ url: src.url, mode: req.mode, engine: req.engine });
      return over.plays ? over.plays(req, src.url) : { ok: true };
    },
    ...over,
  };
  return repairAndPlay(deps, (s) => updates.push(s)).then((final) => ({ final, calls, updates }));
}

describe("repairAndPlay", () => {
  it("plays a healthy channel directly and reports every step done", async () => {
    const { final, calls, updates } = await run({});
    expect(final.outcome).toBe("playing");
    expect(final.source).toMatchObject({ origin: "current", mode: "direct", engine: "hlsjs" });
    expect(calls).toHaveLength(1);
    expect(final.progress).toBe(1);
    expect(final.stage).toBe("start");
    expect(final.action).toBe("inspect"); // nothing needed repairing: no retry/relay/alternate action is claimed
    expect(updates.map((u) => u.progress)).toEqual([...updates.map((u) => u.progress)].sort((a, b) => a - b)); // progress never goes backwards
  });

  it("does not trust a healthy probe: if the player never starts, it repairs and tries the next source", async () => {
    const { final, calls } = await run({
      findSources: async () => [cand("https://alt.example/b.m3u8", "catalog")],
      plays: (_r, url) => (url.includes("alt.example") ? { ok: true } : { ok: false, cause: "no_media_data" }),
    });
    expect(final.outcome).toBe("playing");
    expect(final.source?.origin).toBe("catalog");
    expect(calls.filter((c) => c.url.includes("o.example")).length).toBeGreaterThan(1); // direct, then relay / other engine
  });

  it("retries transient failures a bounded number of times, then moves on", async () => {
    let n = 0;
    const { final, calls } = await run({ plays: () => (++n, { ok: false, cause: "timeout" }), retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 } });
    expect(final.outcome).toBe("unavailable");
    // engines(hlsjs, native) x modes(direct, relay) x 2 attempts, nothing more
    expect(calls.length).toBe(8);
  });

  it("uses the relay only for http origins on an https page", async () => {
    const { calls } = await run({ diagnose: async () => diag({ url: "http://o.example/a.m3u8" }) });
    expect(calls[0]!.mode).toBe("relay");
  });

  it("switches to a compatible player when the first engine fails", async () => {
    const { final, calls } = await run({ plays: (r) => (r.engine === "native" ? { ok: true } : { ok: false, cause: "player_error" }), retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
    expect(final.source?.engine).toBe("native");
    expect(calls.map((c) => c.engine)).toContain("hlsjs");
  });

  it("does not hammer a refused stream; it goes straight to authorized alternates", async () => {
    const { final, calls } = await run({
      diagnose: async () => diag({ ok: false, cause: "gone", httpStatus: 404, steps: [{ id: "server", ok: false, detail: "HTTP 404" }] }),
      findSources: async () => [cand("https://alt.example/b.m3u8", "registered")],
    });
    expect(final.outcome).toBe("playing");
    expect(calls.every((c) => c.url.includes("alt.example"))).toBe(true);
    expect(final.cause).toBe("gone"); // the real cause stays visible
  });

  it("prefers a renewed link from the user's own source and reports it", async () => {
    const { final } = await run({
      diagnose: async () => diag({ ok: false, cause: "forbidden" }),
      findSources: async () => [cand("https://o.example/a.m3u8?token=new", "renewed")],
    });
    expect(final.source?.origin).toBe("renewed");
    expect(final.action).toBe("renew");
  });

  it("skips alternates whose codecs this device cannot decode", async () => {
    const bad = cand("https://alt.example/hevc.m3u8");
    bad.diagnosis.codecs = ["hvc1.2.4.L120"];
    const { final, calls } = await run({
      capabilities: () => caps({ codec: (c) => !c.startsWith("hvc1") }),
      diagnose: async () => diag({ ok: false, cause: "gone" }),
      findSources: async () => [bad, cand("https://alt.example/h264.m3u8")],
    });
    expect(calls).toHaveLength(1);
    expect(final.source?.url).toContain("h264");
  });

  it("reports DRM streams as needing the official subscription, never as playable", async () => {
    const { final, calls } = await run({
      diagnose: async () => diag({ ok: false, cause: "drm_protected", protection: { drm: ["widevine"], encrypted: true, licenseUrls: [] } }),
      capabilities: () => caps({ drm: ["widevine"] }),
    });
    expect(final.outcome).toBe("needs_action");
    expect(final.needs).toBe("subscription");
    expect(final.cause).toBe("drm_protected");
    expect(calls).toHaveLength(0);
  });

  it("explains when the device lacks the required key system", async () => {
    const { final } = await run({
      diagnose: async () => diag({ ok: false, cause: "drm_protected", protection: { drm: ["fairplay"], encrypted: true, licenseUrls: [] } }),
      capabilities: () => caps({ drm: ["widevine"] }),
    });
    expect(final.needs).toBe("device_drm");
  });

  it("plays a DRM stream through the provider's advertised license server when the device supports it", async () => {
    const { final, calls } = await run({
      diagnose: async () => diag({ protection: { drm: ["widevine"], encrypted: true, licenseUrls: ["https://lic.example/w"] } }),
      capabilities: () => caps({ drm: ["widevine"] }),
      plays: (r) => (r.license?.url === "https://lic.example/w" ? { ok: true } : { ok: false }),
    });
    expect(final.outcome).toBe("playing");
    expect(calls).toHaveLength(1);
  });

  it("asks for login on auth errors, and still tries authorized alternates first", async () => {
    const authFail = { diagnose: async () => diag({ ok: false, cause: "auth_required" as const, accountProblem: "login_rejected" as const }) };
    const none = await run(authFail);
    expect(none.final.outcome).toBe("needs_action");
    expect(none.final.needs).toBe("login");
    const alt = await run({ ...authFail, findSources: async () => [cand("https://free.example/x.m3u8")] });
    expect(alt.final.outcome).toBe("playing");
  });

  it("shows a Play button state when the browser blocks autoplay after the media loaded", async () => {
    const { final } = await run({ plays: () => ({ ok: true, needsGesture: true }) });
    expect(final.outcome).toBe("playing");
    expect(final.needs).toBe("tap_play");
  });

  it("is honest when nothing works", async () => {
    const { final } = await run({ diagnose: async () => diag({ ok: false, cause: "gone" }), findSources: async () => [] });
    expect(final.outcome).toBe("unavailable");
    expect(final.scanning).toBe(false);
  });

  it("survives the diagnosis call itself failing", async () => {
    const { final } = await run({ diagnose: async () => { throw new Error("offline"); } });
    expect(final.outcome).toBe("unavailable");
    expect(final.causeDetail).toBe("offline");
  });
});
