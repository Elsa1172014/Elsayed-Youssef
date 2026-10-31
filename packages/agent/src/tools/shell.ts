import { spawn } from "node:child_process";
import type { RiskLevel, Tool } from "../types.js";

/** Programs considered read-only/inspection-only when invoked without shell operators. */
const READ_ONLY = new Set([
  "ls", "dir", "pwd", "cat", "type", "echo", "whoami", "hostname", "date", "uname", "df", "ps",
  "tasklist", "git status", "git log", "git diff", "node --version", "python --version", "ipconfig", "systeminfo",
]);
const SHELL_OPERATORS = /[;&|><`$()\n]/;

export function classifyCommand(command: string): RiskLevel {
  const trimmed = command.trim();
  if (SHELL_OPERATORS.test(trimmed)) return "high";
  const two = trimmed.split(/\s+/).slice(0, 2).join(" ");
  const one = trimmed.split(/\s+/)[0] ?? "";
  if (READ_ONLY.has(two) || READ_ONLY.has(one) || READ_ONLY.has(trimmed)) return "low";
  return "high";
}

function shellFor(platform: NodeJS.Platform): { file: string; args: (c: string) => string[] } {
  return platform === "win32"
    ? { file: "powershell.exe", args: (c) => ["-NoProfile", "-NonInteractive", "-Command", c] }
    : { file: "/bin/sh", args: (c) => ["-c", c] };
}

export const runCommandTool: Tool = {
  name: "run_command",
  group: "shell",
  description:
    "Run a shell command (PowerShell on Windows, sh elsewhere) with a timeout. Read-only inspection commands are low risk; anything else needs approval.",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" }, timeout_seconds: { type: "number" }, cwd: { type: "string" } },
    required: ["command"],
  },
  risk: (a) => classifyCommand(String(a["command"] ?? "")),
  describeCall: (a) => `run: ${String(a["command"])}`,
  async run(a, ctx) {
    const command = String(a["command"] ?? "");
    const timeout = Math.min(Math.max(Number(a["timeout_seconds"] ?? 60), 1), 600) * 1000;
    const sh = shellFor(process.platform);
    return await new Promise((resolveP) => {
      const child = spawn(sh.file, sh.args(command), {
        cwd: typeof a["cwd"] === "string" ? (a["cwd"] as string) : ctx.cwd,
        windowsHide: true,
      });
      let out = "";
      const cap = (d: Buffer): void => {
        if (out.length < 60_000) out += d.toString();
      };
      child.stdout.on("data", cap);
      child.stderr.on("data", cap);
      const kill = (): void => {
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => {
        kill();
        resolveP({ ok: false, output: `${out}\n[timed out after ${timeout / 1000}s]` });
      }, timeout);
      ctx.signal.addEventListener("abort", () => {
        kill();
        clearTimeout(timer);
        resolveP({ ok: false, output: `${out}\n[cancelled]` });
      }, { once: true });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolveP({ ok: false, output: `failed to start: ${e.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolveP({ ok: code === 0, output: `${out}\n[exit code ${code}]` });
      });
    });
  },
};
