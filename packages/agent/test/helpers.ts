import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/agent/store.js";
import { AuditLog } from "../src/security/audit.js";
import { PermissionEngine, type Approver, type PermissionMode } from "../src/security/permissions.js";
import { fileTools } from "../src/tools/files.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { runCommandTool } from "../src/tools/shell.js";
import type { RunDeps } from "../src/agent/loop.js";
import type { LlmProvider } from "../src/types.js";

export function makeEnv(provider: LlmProvider, opts: { mode?: PermissionMode; approve?: Approver; limits?: RunDeps["limits"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nexus-"));
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const registry = new ToolRegistry();
  for (const t of [...fileTools, runCommandTool]) registry.register(t);
  const approvals: string[] = [];
  const approve: Approver = opts.approve ?? (async (r) => { approvals.push(r.summary); return true; });
  const permissions = new PermissionEngine(
    { mode: opts.mode ?? "ask", allowedRoots: [join(dir, "work")], deniedTools: [], allowedTools: [] },
    approve, audit,
  );
  const store = new TaskStore(":memory:");
  const deps: RunDeps = {
    provider, registry, permissions, audit, store,
    ctx: { cwd: join(dir, "work"), trashDir: join(dir, "trash") },
    limits: opts.limits,
  };
  return { dir, work: join(dir, "work"), audit, registry, permissions, store, deps, approvals, auditFile: join(dir, "audit.jsonl") };
}

export const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, args });
