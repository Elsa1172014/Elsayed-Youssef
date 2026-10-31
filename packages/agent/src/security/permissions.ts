import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RiskLevel, Tool, ToolContext } from "../types.js";
import type { AuditLog } from "./audit.js";

/**
 * ask   – low runs, medium+high need approval (default)
 * auto  – low+medium run, high needs approval
 * readonly – only low risk runs, everything else is denied
 * Hard-blocked commands are denied in every mode.
 */
export type PermissionMode = "ask" | "auto" | "readonly";

export interface Approver {
  (req: { tool: string; risk: RiskLevel; summary: string }): Promise<boolean>;
}

export interface PolicyConfig {
  mode: PermissionMode;
  /** Absolute directories the agent may read/write. Paths outside are denied. */
  allowedRoots: string[];
  /** Tool names (or "mcp__server__*" prefixes ending with *) always denied. */
  deniedTools: string[];
  /** Tool names pre-approved regardless of risk (never overrides hard blocks). */
  allowedTools: string[];
}

export type Decision =
  | { allow: true; reason: string }
  | { allow: false; reason: string };

/** Commands that are never executed, whatever the mode or approval. */
const HARD_BLOCK: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|~|\$HOME|\*)(\s|$)/i,
  /\bmkfs(\.|\s)/i,
  /\bdd\s+.*\bof=\/dev\/(sd|nvme|hd)/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bformat\s+[a-z]:/i,
  /\bRemove-Item\b.*-Recurse.*\b[A-Z]:\\\s*(\||$)/i,
  /\b(Set-MpPreference|Add-MpPreference)\b.*Disable/i,
  /\bDisable-WindowsOptionalFeature\b.*Defender/i,
  /\bnetsh\s+advfirewall\s+set\s+\w+\s+state\s+off/i,
  /\breg\s+(add|delete)\b.*\\Windows Defender/i,
  /\bbcdedit\b/i,
  /curl[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i,
  /\b(iwr|Invoke-WebRequest|irm)\b[^|]*\|\s*(iex|Invoke-Expression)\b/i,
];

export function hardBlocked(command: string): string | null {
  for (const re of HARD_BLOCK) if (re.test(command)) return `command matches blocked pattern ${re}`;
  return null;
}

function matches(list: string[], name: string): boolean {
  return list.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : p === name));
}

export function pathAllowed(path: string, roots: string[], cwd: string): boolean {
  const abs = resolve(cwd, path);
  return roots.some((root) => {
    const rel = relative(resolve(root), abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(".." + sep));
  });
}

export class PermissionEngine {
  constructor(
    public config: PolicyConfig,
    private readonly approve: Approver,
    private readonly audit: AuditLog,
  ) {}

  /** Decide whether a tool call may run. Approval prompts happen here, never inside tools. */
  async authorize(tool: Tool, args: Record<string, unknown>, ctx: ToolContext, taskId?: string): Promise<Decision> {
    const risk = tool.risk(args, ctx);
    const summary = tool.describeCall(args);
    const deny = (reason: string): Decision => {
      this.audit.write({ taskId, kind: "denied", tool: tool.name, risk, detail: `${summary} :: ${reason}` });
      return { allow: false, reason };
    };

    if (matches(this.config.deniedTools, tool.name)) return deny("tool is revoked by policy");

    const cmd = typeof args["command"] === "string" ? (args["command"] as string) : null;
    if (cmd) {
      const blocked = hardBlocked(cmd);
      if (blocked) return deny(blocked);
    }

    for (const p of tool.paths?.(args, ctx) ?? []) {
      if (!pathAllowed(p, this.config.allowedRoots, ctx.cwd)) {
        return deny(`path outside allowed roots: ${p}`);
      }
    }

    if (this.config.mode === "readonly" && risk !== "low") return deny("read-only mode");

    const preApproved = matches(this.config.allowedTools, tool.name);
    const needsApproval =
      !preApproved && (risk === "high" || (risk === "medium" && this.config.mode === "ask"));

    if (!needsApproval) {
      this.audit.write({ taskId, kind: "tool_call", tool: tool.name, risk, detail: summary });
      return { allow: true, reason: preApproved ? "pre-approved" : "within policy" };
    }

    const ok = await this.approve({ tool: tool.name, risk, summary });
    this.audit.write({ taskId, kind: "approval", tool: tool.name, risk, detail: `${ok ? "APPROVED" : "REJECTED"}: ${summary}` });
    return ok ? { allow: true, reason: "user approved" } : { allow: false, reason: "user rejected" };
  }
}
