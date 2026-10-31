import { cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from "node:os";
import type { Tool } from "../types.js";
import { runCommandTool } from "./shell.js";

export const systemInfoTool: Tool = {
  name: "system_info",
  group: "system",
  description: "CPU, memory, uptime, OS and host information.",
  inputSchema: { type: "object", properties: {} },
  risk: () => "low",
  describeCall: () => "read system info",
  async run() {
    const info = {
      host: hostname(),
      os: `${platform()} ${release()}`,
      cpuModel: cpus()[0]?.model ?? "unknown",
      cpuCores: cpus().length,
      loadAvg: loadavg().map((n) => Number(n.toFixed(2))),
      memTotalMB: Math.round(totalmem() / 1048576),
      memFreeMB: Math.round(freemem() / 1048576),
      uptimeHours: Number((uptime() / 3600).toFixed(1)),
    };
    return { ok: true, output: JSON.stringify(info, null, 2), data: info };
  },
};

export const listProcessesTool: Tool = {
  name: "list_processes",
  group: "system",
  description: "List running processes (name, pid, memory).",
  inputSchema: { type: "object", properties: {} },
  risk: () => "low",
  describeCall: () => "list processes",
  async run(_a, ctx) {
    const cmd =
      process.platform === "win32"
        ? "Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 40 Name,Id,@{n='MB';e={[int]($_.WorkingSet/1MB)}} | Format-Table -AutoSize | Out-String"
        : "ps -eo pid,comm,rss --sort=-rss | head -40";
    return runCommandTool.run({ command: cmd }, ctx);
  },
};

export const systemTools: Tool[] = [systemInfoTool, listProcessesTool];
