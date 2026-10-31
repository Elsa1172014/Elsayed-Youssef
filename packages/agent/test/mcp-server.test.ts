import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { runTask, summarize } from "../src/agent/loop.js";
import { ScriptedProvider } from "../src/llm/router.js";
import { McpHub } from "../src/mcp/hub.js";
import { startServer } from "../src/server.js";
import type { NexusConfig } from "../src/config.js";
import { call, makeEnv } from "./helpers.js";

const fixture = join(process.cwd(), "test/fixtures/echo-mcp.mjs");
const use = (...calls: ReturnType<typeof call>[]) => ({ content: "", toolCalls: calls });

describe("MCP hub", () => {
  it("connects a real stdio MCP server, discovers tools, gates risk, and calls through the permission engine", async () => {
    const p = new ScriptedProvider([
      use(call("1", "mcp__echo__echo", { text: "سلام" })),
      use(call("2", "mcp__echo__send_email", { to: "a@b.c" })),
      { content: "done", toolCalls: [] },
    ]);
    const env = makeEnv(p, { approve: async (r) => !r.tool.endsWith("send_email") });
    const hub = new McpHub(env.registry, env.audit);
    const st = await hub.connect("echo", { command: process.execPath, args: [fixture], readOnlyTools: ["echo"], highRiskTools: ["send_email"] });
    expect(st.connected).toBe(true);
    expect(st.tools).toEqual(["mcp__echo__echo", "mcp__echo__send_email"]);
    expect((await hub.health())[0]).toEqual({ name: "echo", ok: true });

    const rec = await runTask(env.deps, { goal: "mcp" });
    expect(rec.steps[0]).toMatchObject({ ok: true });
    expect(rec.steps[0]!.output).toBe("echo:سلام");
    expect(rec.steps[1]).toMatchObject({ denied: true }); // external send rejected
    await hub.disconnectAll();
    expect(env.registry.get("mcp__echo__echo")).toBeUndefined(); // tool revocation on disconnect
  }, 30000);

  it("reports a failed connection without throwing", async () => {
    const env = makeEnv(new ScriptedProvider([{ content: "", toolCalls: [] }]));
    const hub = new McpHub(env.registry, env.audit);
    const st = await hub.connect("ghost", { command: "definitely-not-a-real-binary-xyz" });
    expect(st.connected).toBe(false);
    expect(st.error).toBeTruthy();
  });
});

describe("web control center", () => {
  const cfg: NexusConfig = { mode: "ask", allowedRoots: [], deniedTools: [], allowedTools: [], providers: [], mcpServers: {}, maxSteps: 10 };

  it("requires a token, rejects foreign hosts, and runs a task end-to-end with browser-style approval", async () => {
    const dir = (await import("node:fs")).mkdtempSync(join((await import("node:os")).tmpdir(), "nexus-srv-"));
    const target = join(dir, "work", "web.txt");
    const provider = new ScriptedProvider([
      use(call("1", "write_file", { path: target, content: "from web" })),
      { content: "تم", toolCalls: [] },
    ]);
    const s = await startServer({ provider, config: cfg, home: join(dir, "home"), cwd: join(dir, "work"), connectMcp: false, token: "t0k3n" });
    const base = `http://127.0.0.1:${s.port}`;
    const H = { authorization: "Bearer t0k3n", "content-type": "application/json" };
    try {
      expect((await fetch(`${base}/api/tasks`)).status).toBe(401);
      expect((await fetch(`${base}/api/tasks`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      const rawStatus = await new Promise<number>((resolve) => {
        const r = httpRequest({ host: "127.0.0.1", port: s.port, path: "/api/status", headers: { authorization: "Bearer t0k3n", host: "evil.example.com" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        r.end();
      });
      expect(rawStatus).toBe(403); // DNS-rebinding style Host rejected even with a valid token
      expect((await fetch(`${base}/`)).status).toBe(200);

      const { taskId } = (await (await fetch(`${base}/api/tasks`, { method: "POST", headers: H, body: JSON.stringify({ goal: "اكتب" }) })).json()) as { taskId: string };
      let pending: { id: string }[] = [];
      for (let i = 0; i < 50 && pending.length === 0; i++) {
        pending = (await (await fetch(`${base}/api/approvals`, { headers: H })).json()) as { id: string }[];
        if (!pending.length) await new Promise((r) => setTimeout(r, 40));
      }
      expect(pending.length).toBe(1);
      expect(existsSync(target)).toBe(false); // nothing happens before approval
      await fetch(`${base}/api/approvals/${pending[0]!.id}`, { method: "POST", headers: H, body: JSON.stringify({ approve: true }) });

      let rec: { status: string; report: { verified: number } } = { status: "running", report: { verified: 0 } };
      for (let i = 0; i < 50 && rec.status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 40));
        rec = (await (await fetch(`${base}/api/tasks/${taskId}`, { headers: H })).json()) as typeof rec;
      }
      expect(rec.status).toBe("completed");
      expect(rec.report.verified).toBe(1);
      expect(readFileSync(target, "utf8")).toBe("from web");
    } finally {
      await s.close();
    }
  }, 30000);

  it("emergency stop rejects pending approvals and cancels running tasks", async () => {
    const dir = (await import("node:fs")).mkdtempSync(join((await import("node:os")).tmpdir(), "nexus-srv-"));
    const target = join(dir, "work", "never.txt");
    const provider = new ScriptedProvider([use(call("1", "write_file", { path: target, content: "x" })), { content: "x", toolCalls: [] }]);
    const s = await startServer({ provider, config: cfg, home: join(dir, "home"), cwd: join(dir, "work"), connectMcp: false, token: "t" });
    const base = `http://127.0.0.1:${s.port}`;
    const H = { authorization: "Bearer t", "content-type": "application/json" };
    try {
      const { taskId } = (await (await fetch(`${base}/api/tasks`, { method: "POST", headers: H, body: JSON.stringify({ goal: "g" }) })).json()) as { taskId: string };
      for (let i = 0; i < 50; i++) {
        const a = (await (await fetch(`${base}/api/approvals`, { headers: H })).json()) as unknown[];
        if (a.length) break;
        await new Promise((r) => setTimeout(r, 40));
      }
      await fetch(`${base}/api/emergency-stop`, { method: "POST", headers: H });
      await new Promise((r) => setTimeout(r, 300));
      expect(existsSync(target)).toBe(false);
      const rec = (await (await fetch(`${base}/api/tasks/${taskId}`, { headers: H })).json()) as { status: string };
      expect(["cancelled", "completed", "failed"]).toContain(rec.status);
      expect(rec.status).not.toBe("running");
    } finally {
      await s.close();
    }
  }, 30000);
});
