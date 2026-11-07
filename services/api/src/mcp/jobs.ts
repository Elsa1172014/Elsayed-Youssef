import type { HubStore } from "../hub/store";
import type { ApiCall } from "./server";
import type { McpStore } from "./store";

/**
 * Daily MCP job: for every user with an active auto-sync token, re-sync their syncable sources and re-check up to
 * 10 favourite channels (history in hub.stream_checks). Stops early when the time budget is used. Never deletes anything.
 */
export async function runMcpSync(hub: HubStore, mcp: McpStore, apiFor: (uid: string) => ApiCall, opts: { deadline: number; trigger?: "cron" | "manual" } ) {
  const run = await hub.startJob("mcp-sync", opts.trigger ?? "cron");
  const stats = { users: 0, sources: 0, sourceErrors: 0, checks: 0, playable: 0, stoppedEarly: false };
  const timeLeft = () => opts.deadline - Date.now();
  try {
    for (const uid of await mcp.autoSyncUsers()) {
      if (timeLeft() < 6_000) { stats.stoppedEarly = true; break; }
      stats.users++;
      const api = apiFor(uid);
      const list = await api("GET", "/v1/me/sources");
      const sources = list.status === 200 ? (list.json as { id: string; type: string; enabled: boolean }[]).filter((s) => s.enabled && s.type !== "m3u_file") : [];
      for (const s of sources.slice(0, 10)) {
        if (timeLeft() < 6_000) { stats.stoppedEarly = true; break; }
        const r = await api("POST", `/v1/me/sources/${s.id}/sync`);
        stats.sources++;
        if (r.status !== 200) { stats.sourceErrors++; await hub.logError("mcp-sync", `source ${s.id}: ${(r.json as { error?: string })?.error ?? r.status}`, { user: uid.slice(0, 8) }, "mcp-sync"); }
      }
      for (const f of (await mcp.favourites(uid)).slice(0, 10)) {
        if (timeLeft() < 4_000) { stats.stoppedEarly = true; break; }
        const r = await api("POST", `/v1/me/channels/${encodeURIComponent(f.channelId)}/diagnose`);
        if (r.status !== 200) continue;
        const d = r.json as { ok: boolean; cause?: string; kind?: string; httpStatus?: number; latencyMs?: number };
        await mcp.recordCheck(uid, { channelId: f.channelId, ok: d.ok, cause: d.cause, kind: d.kind, httpStatus: d.httpStatus, latencyMs: d.latencyMs, trigger: "cron" });
        stats.checks++;
        if (d.ok) stats.playable++;
      }
    }
    await hub.finishJob(run, stats.sourceErrors < stats.sources || stats.sources === 0, stats);
    return { ok: true, ...stats };
  } catch (e) {
    await hub.logError("mcp-sync", (e as Error).message, {}, "mcp-sync");
    await hub.finishJob(run, false, stats, (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}
