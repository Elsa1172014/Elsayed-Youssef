import { DEFAULT_RETRY, NEEDS_USER, RETRYABLE, withRetry, type Cause, type DrmSystem, type Protection, type RetryPolicy, type StreamKind } from "./playback";

/**
 * "Repair & Play": diagnose -> repair -> find an authorized source -> play, with every step verified against a real
 * player (a 200 response is never treated as "working"). Environment-specific parts (server probes, the <video>
 * element, device capabilities) are injected, so the control flow is deterministic and unit-tested.
 * Hard boundary: nothing here bypasses CORS policies, geo-blocks, logins or DRM. Those outcomes are reported to the
 * user as "needs login / subscription / not available".
 */

export interface ProbeStep {
  id: "url" | "server" | "type" | "manifest" | "protection" | "media";
  ok: boolean;
  skipped?: boolean;
  detail: string;
}

export interface Diagnosis {
  ok: boolean;
  url: string;
  /** Signed same-origin relay for this exact URL (used when the browser cannot reach the origin directly). */
  proxy: string;
  kind: StreamKind;
  cause: Cause;
  httpStatus?: number;
  latencyMs?: number;
  codecs: string[];
  protection: Protection;
  steps: ProbeStep[];
  /** The channel comes from a user-entered subscription (Xtream) whose login was rejected or lapsed. */
  accountProblem?: "login_rejected" | "subscription_inactive";
}

export interface Candidate {
  name: string;
  url: string;
  proxy: string;
  /** renewed: fresh link from the user's own source; catalog: another listed stream of the same channel; registered: same channel in another of the user's sources. */
  origin: "renewed" | "catalog" | "registered";
  diagnosis: Diagnosis;
}

export interface Capabilities {
  /** hls.js via MediaSource ("mse"), the platform's native HLS (Safari/TV), or both. */
  hls: "mse" | "native" | "both" | "none";
  dash: boolean;
  /** MediaSource/video support for one RFC 6381 codec string. */
  codec(codec: string): boolean;
  /** Key systems the device exposes for encrypted playback. */
  drm: DrmSystem[];
}

export type Engine = "hlsjs" | "native" | "dashjs";
export type Mode = "direct" | "relay";

export interface PlayRequest {
  url: string;
  mode: Mode;
  engine: Engine;
  kind: StreamKind;
  license?: { system: DrmSystem; url: string };
}
export interface PlayResult {
  ok: boolean;
  cause?: Cause;
  detail?: string;
  /** Media loaded but the browser refused to start it without a tap. */
  needsGesture?: boolean;
}

export interface RepairDeps {
  capabilities(): Capabilities;
  diagnose(): Promise<Diagnosis>;
  /** Server-side search + test of the channel's authorized alternates; returns only candidates that passed the probe. */
  findSources(): Promise<Candidate[]>;
  /** Plays on a real element and resolves only when media data arrived and playback began (or autoplay was blocked after load). */
  play(req: PlayRequest, source: { url: string; proxy: string }): Promise<PlayResult>;
  /** The page is https: plain-http origins can only go through the relay. */
  pageIsHttps: boolean;
  sleep?(ms: number): Promise<void>;
  retry?: RetryPolicy;
  maxAlternates?: number;
}

export type StepId = "device" | "inspect" | "protection" | "play" | "repair" | "start";
export type StepStatus = "pending" | "running" | "ok" | "fail" | "skip";
export type Action = "inspect" | "retry" | "change_player" | "relay" | "renew" | "test_alternate" | "verify_license";
export type Outcome = "playing" | "needs_action" | "unavailable";
export type NeedsKind = "login" | "subscription" | "license" | "device_drm" | "tap_play";

export interface PanelState {
  scanning: boolean;
  stage: StepId;
  steps: Record<StepId, { status: StepStatus; detail?: string }>;
  /** Completed steps (ok/fail/skip) over all steps: reflects work actually finished. */
  progress: number;
  cause?: Cause;
  causeDetail?: string;
  action?: Action;
  outcome?: Outcome;
  needs?: NeedsKind;
  diagnosis?: Diagnosis;
  source?: PlayedSource;
  log: string[];
}

export interface PlayedSource {
  url: string;
  proxy: string;
  mode: Mode;
  engine: Engine;
  kind: StreamKind;
  origin: "current" | Candidate["origin"];
  name?: string;
  needsGesture?: boolean;
}

const ORDER: StepId[] = ["device", "inspect", "protection", "play", "repair", "start"];
const fresh = (): PanelState => ({
  scanning: true,
  stage: "device",
  steps: Object.fromEntries(ORDER.map((id) => [id, { status: "pending" as StepStatus }])) as PanelState["steps"],
  progress: 0,
  log: [],
});

const enginesFor = (kind: StreamKind, caps: Capabilities): Engine[] => {
  if (kind === "dash") return caps.dash ? ["dashjs"] : [];
  if (kind === "hls" || kind === "unknown") return [...(caps.hls === "mse" || caps.hls === "both" ? (["hlsjs"] as Engine[]) : []), ...(caps.hls === "native" || caps.hls === "both" ? (["native"] as Engine[]) : [])];
  return ["native"];
};

/** Codecs the device cannot decode. Unknown/unlisted codecs are given the benefit of the doubt. */
export const unsupportedCodecs = (codecs: string[], caps: Capabilities): string[] => codecs.filter((c) => !caps.codec(c));

export async function repairAndPlay(deps: RepairDeps, onUpdate: (s: PanelState) => void, signal?: AbortSignal): Promise<PanelState> {
  const st = fresh();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const policy = deps.retry ?? DEFAULT_RETRY;
  const emit = () => {
    st.progress = ORDER.filter((id) => !["pending", "running"].includes(st.steps[id].status)).length / ORDER.length;
    onUpdate(structuredClone(st));
  };
  const begin = (id: StepId, action?: Action) => {
    st.stage = id;
    st.steps[id] = { status: "running" };
    if (action) st.action = action;
    emit();
  };
  const end = (id: StepId, status: StepStatus, detail?: string) => {
    st.steps[id] = { status, detail };
    emit();
  };
  const note = (m: string) => st.log.push(m);
  const aborted = () => signal?.aborted === true;
  const finish = (outcome: Outcome, needs?: NeedsKind) => {
    st.scanning = false;
    st.outcome = outcome;
    st.needs = needs;
    for (const id of ORDER) if (st.steps[id].status === "pending" || st.steps[id].status === "running") st.steps[id] = { status: "skip" };
    emit();
    return structuredClone(st);
  };
  const succeed = (src: PlayedSource) => {
    st.source = src;
    st.stage = "start";
    end("start", "ok");
    return finish("playing", src.needsGesture ? "tap_play" : undefined);
  };

  // 1. Device capabilities
  begin("device");
  const caps = deps.capabilities();
  end("device", caps.hls === "none" && !caps.dash ? "fail" : "ok", `hls=${caps.hls} dash=${caps.dash} drm=${caps.drm.join(",") || "none"}`);

  // 2. Inspect the stream (URL, HTTP answer, type, manifest, real media bytes)
  begin("inspect", "inspect");
  let diag: Diagnosis;
  try {
    diag = await deps.diagnose();
  } catch (e) {
    st.cause = "network";
    st.causeDetail = (e as Error).message;
    end("inspect", "fail", st.causeDetail);
    diag = { ok: false, url: "", proxy: "", kind: "unknown", cause: "network", codecs: [], protection: { drm: [], encrypted: false, licenseUrls: [] }, steps: [] };
  }
  st.diagnosis = diag;
  if (st.steps.inspect.status === "running") end("inspect", diag.ok ? "ok" : "fail", diag.steps.find((s) => !s.ok && !s.skipped)?.detail);
  st.cause = diag.ok ? undefined : diag.cause;
  st.causeDetail = diag.steps.find((s) => !s.ok && !s.skipped)?.detail ?? st.causeDetail;
  if (aborted()) return finish("unavailable");

  // 3. Protection: DRM systems the stream asks for vs. what this device offers. Login-gated streams are surfaced to the user.
  begin("protection");
  let needs: NeedsKind | undefined;
  let license: PlayRequest["license"];
  if (diag.protection.drm.length > 0) {
    st.action = "verify_license";
    const usable = diag.protection.drm.filter((d) => caps.drm.includes(d));
    st.cause = "drm_protected";
    if (usable.length === 0) {
      needs = "device_drm";
      end("protection", "fail", `needs ${diag.protection.drm.join("/")}`);
    } else if (diag.protection.licenseUrls[0]) {
      license = { system: usable[0]!, url: diag.protection.licenseUrls[0] };
      end("protection", "ok", `${usable[0]} via the provider's license server`);
    } else {
      needs = "subscription"; // no official license endpoint is published: only the provider's own app/login can unlock it
      end("protection", "fail", `needs ${diag.protection.drm.join("/")} license from the provider`);
    }
  } else if (diag.cause === "auth_required" || diag.accountProblem) {
    needs = diag.accountProblem === "subscription_inactive" ? "subscription" : "login";
    end("protection", "fail", "login required");
  } else {
    end("protection", "skip", diag.protection.encrypted ? "AES-128 (handled by the player)" : "clear");
  }

  const bad = unsupportedCodecs(diag.codecs, caps);
  const everyCodecBad = diag.codecs.length > 0 && bad.length === diag.codecs.length;
  if (everyCodecBad) {
    st.cause = "codec_unsupported";
    st.causeDetail = bad.join(", ");
    note(`unsupported codecs: ${bad.join(", ")}`);
  }

  // 4. Play the current source (bounded): transient failures retry, then another mode/engine, never an endless loop.
  const attemptSource = async (src: { url: string; proxy: string }, d: Diagnosis, origin: PlayedSource["origin"], name?: string): Promise<PlayedSource | undefined> => {
    const engines = enginesFor(d.kind, caps);
    const modes: Mode[] = deps.pageIsHttps && src.url.startsWith("http:") ? ["relay"] : ["direct", "relay"];
    let tried = 0;
    for (const engine of engines) {
      for (const mode of modes) {
        if (aborted()) return undefined;
        tried++;
        if (tried > 1) st.action = mode === "relay" && modes.length > 1 && tried === 2 ? "relay" : "change_player";
        emit();
        const res = await withRetry<PlayResult>(
          async () => deps.play({ url: mode === "relay" ? src.proxy : src.url, mode, engine, kind: d.kind, license }, src),
          policy,
          sleep,
          (n) => {
            st.action = "retry";
            note(`retry ${n} (${engine}/${mode})`);
            emit();
          },
        );
        if (res.ok) return { url: src.url, proxy: src.proxy, mode, engine, kind: d.kind, origin, name, needsGesture: res.needsGesture };
        st.cause = res.cause ?? st.cause ?? "player_error";
        st.causeDetail = res.detail ?? st.causeDetail;
        note(`${engine}/${mode} failed: ${res.cause ?? "error"} ${res.detail ?? ""}`.trim());
        if (res.cause && NEEDS_USER.has(res.cause) && res.cause !== "autoplay_blocked") return undefined;
        if (res.cause === "gone" || res.cause === "forbidden" || res.cause === "geo_blocked") return undefined; // a refusal: another mode will not change the answer
      }
    }
    return undefined;
  };

  begin("play");
  const blocked = !diag.ok && !RETRYABLE.has(diag.cause) && diag.cause !== "player_error";
  const usable = !!diag.url && !needs && !everyCodecBad && enginesFor(diag.kind, caps).length > 0;
  if (usable && (diag.ok || !blocked)) {
    const played = await attemptSource({ url: diag.url, proxy: diag.proxy }, diag, "current");
    if (played) {
      end("play", "ok", `${played.engine}/${played.mode}`);
      st.steps.repair = { status: "skip" };
      st.cause = undefined;
      return succeed(played);
    }
    end("play", "fail", st.causeDetail);
  } else {
    end("play", "skip", needs ? "needs your action" : blocked ? `blocked: ${diag.cause}` : "not playable on this device");
  }
  if (aborted()) return finish("unavailable");

  // 5. Find an authorized alternate: renewed link from the user's own source, the channel's other listed streams, or the same channel in another registered source.
  begin("repair", "test_alternate");
  let candidates: Candidate[] = [];
  try {
    candidates = (await deps.findSources()).slice(0, deps.maxAlternates ?? 4);
  } catch (e) {
    note(`source search failed: ${(e as Error).message}`);
  }
  for (const c of candidates) {
    if (aborted()) break;
    if (c.origin === "renewed") st.action = "renew";
    if (c.diagnosis.protection.drm.length > 0 || enginesFor(c.diagnosis.kind, caps).length === 0) continue; // an alternate must be clear and playable here
    if (c.diagnosis.codecs.length > 0 && unsupportedCodecs(c.diagnosis.codecs, caps).length === c.diagnosis.codecs.length) continue;
    emit();
    const played = await attemptSource(c, c.diagnosis, c.origin, c.name);
    if (played) {
      end("repair", "ok", `${c.origin}: ${c.name}`);
      st.cause = st.diagnosis?.ok ? undefined : st.cause; // keep the original cause visible: it is why a fix was needed
      return succeed(played);
    }
  }
  end("repair", "fail", candidates.length ? `${candidates.length} alternate(s) tested, none played` : "no authorized alternate found");

  // 6. Nothing played: be honest about why.
  st.steps.start = { status: "skip" };
  if (needs) return finish("needs_action", needs);
  if (st.cause === "auth_required") return finish("needs_action", "login");
  return finish("unavailable");
}
