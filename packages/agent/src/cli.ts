#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { loadConfig, nexusHome } from "./config.js";
import { createRuntime } from "./runtime.js";
import { startServer } from "./server.js";
import type { Approver } from "./security/permissions.js";

const HELP = `AI NEXUS agent
  nexus run "<task>"        run a task in the terminal (asks before risky actions)
  nexus serve [--port N]    start the local web control center (http://127.0.0.1:N/#token=...)
  nexus tasks               list recent tasks
  nexus resume <id>         resume an interrupted task
  nexus mcp                 connect configured MCP servers and list their tools
  nexus tools               list available tools
Config: ${nexusHome()}/config.json   Audit log: ${nexusHome()}/audit.jsonl`;

const terminalApprover: Approver = async (req) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = await rl.question(`\n⚠  [${req.risk.toUpperCase()}] ${req.tool}\n   ${req.summary}\n   Approve? (y/N) `);
    return /^(y|yes|ن|نعم)$/i.test(a.trim());
  } finally {
    rl.close();
  }
};

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "run": {
      const goal = rest.join(" ").trim();
      if (!goal) return void console.log(HELP);
      const rt = await createRuntime({
        approver: terminalApprover,
        onEvent: (e) => {
          if (e.type === "step") console.log(`${e.step.denied ? "⛔" : e.step.ok ? (e.step.verified ? "✔✔" : "✔") : "✖"} ${e.step.summary}`);
        },
      });
      const ac = new AbortController();
      process.on("SIGINT", () => ac.abort());
      const { report } = await rt.run(goal, { signal: ac.signal });
      console.log(`\n${report.answer}\n\n[task ${report.taskId}] ${report.status} · ok ${report.completed} (verified ${report.verified}) · failed ${report.failed} · denied ${report.denied}`);
      await rt.close();
      process.exitCode = report.status === "completed" ? 0 : 1;
      return;
    }
    case "serve": {
      const i = rest.indexOf("--port");
      const s = await startServer({ port: i >= 0 ? Number(rest[i + 1]) : 8787 });
      console.log(`AI NEXUS control center:\n  http://127.0.0.1:${s.port}/#token=${s.token}\n(local only; keep the token private)`);
      process.on("SIGINT", () => void s.close().then(() => process.exit(0)));
      return;
    }
    case "tasks": {
      const rt = await createRuntime({ approver: async () => false, provider: { id: "none", model: "none", complete: async () => { throw new Error("no model"); } }, connectMcp: false });
      for (const t of rt.store.list(20)) console.log(`${t.id}\t${t.status}\t${t.steps.length} steps\t${t.goal.slice(0, 70)}`);
      await rt.close();
      return;
    }
    case "resume": {
      const id = rest[0];
      if (!id) return void console.log(HELP);
      const rt = await createRuntime({ approver: terminalApprover });
      const rec = rt.store.get(id);
      if (!rec) throw new Error(`task not found: ${id}`);
      const { report } = await rt.run(rec.goal, { resumeId: id });
      console.log(`${report.answer}\n[task ${id}] ${report.status}`);
      await rt.close();
      return;
    }
    case "mcp": {
      const cfg = loadConfig();
      const rt = await createRuntime({ approver: async () => false, provider: { id: "none", model: "none", complete: async () => { throw new Error("no model"); } }, config: cfg });
      for (const s of rt.hub.list()) console.log(`${s.connected ? "●" : "○"} ${s.name}${s.error ? "  (" + s.error + ")" : ""}\n   ${s.tools.join("\n   ")}`);
      if (rt.hub.list().length === 0) console.log(`No MCP servers configured. Add them under "mcpServers" in ${nexusHome()}/config.json`);
      await rt.close();
      return;
    }
    case "tools": {
      const rt = await createRuntime({ approver: async () => false, provider: { id: "none", model: "none", complete: async () => { throw new Error("no model"); } }, connectMcp: false });
      for (const t of rt.registry.list()) console.log(`${t.group.padEnd(8)} ${t.name}`);
      await rt.close();
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e: Error) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
