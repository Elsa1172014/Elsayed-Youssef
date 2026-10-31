import { randomUUID } from "node:crypto";
import type { Tool } from "../types.js";
import { BASE_SYSTEM, runTask, type RunDeps } from "./loop.js";

export interface Role {
  name: string;
  groups: Tool["group"][];
  prompt: string;
}

/** Specialised sub-agents. Each only sees the tool groups relevant to its job. */
export const ROLES: Record<string, Role> = {
  computer: {
    name: "computer",
    groups: ["files", "shell", "system", "desktop"],
    prompt: "You are the COMPUTER agent: desktop apps, windows, local files and system state.",
  },
  coder: {
    name: "coder",
    groups: ["files", "shell"],
    prompt: "You are the CODING agent: read code, edit files, run builds and tests, fix failures, and verify by re-running tests.",
  },
  education: {
    name: "education",
    groups: ["files", "documents"],
    prompt:
      "You are the EDUCATION agent (Arabic A/B, Islamic Studies, Social Studies; British/UAE/KHDA contexts). Fill the teacher's OWN template via inspect_docx then fill_docx; never invent curriculum codes, standards or inspection evidence — if a reference is unknown, leave that field unfilled and say so. For data, use analyze_table; keep attainment and progress separate, never impute missing data, and anonymize student names unless asked otherwise.",
  },
  researcher: {
    name: "researcher",
    groups: ["files", "mcp"],
    prompt: "You are the RESEARCH agent: gather information from external tools and files; compare sources; cite which tool produced each fact.",
  },
};

/** Builds the `delegate` tool for the master agent. Sub-agents cannot delegate further (no recursion). */
export function createDelegateTool(deps: RunDeps, depth = 0): Tool {
  return {
    name: "delegate",
    group: "agent",
    description: `Hand a self-contained sub-task to a specialist agent (${Object.keys(ROLES).join(", ")}) and get its verified report.`,
    inputSchema: {
      type: "object",
      properties: { role: { type: "string", enum: Object.keys(ROLES) }, task: { type: "string" } },
      required: ["role", "task"],
    },
    risk: () => "low", // the sub-agent's own tool calls are individually authorized
    describeCall: (a) => `delegate to ${String(a["role"])}: ${String(a["task"]).slice(0, 80)}`,
    async run(a, ctx) {
      const role = ROLES[String(a["role"])];
      if (!role) return { ok: false, output: `unknown role '${String(a["role"])}'` };
      if (depth >= 1) return { ok: false, output: "sub-agents cannot delegate" };
      const rec = await runTask(
        { ...deps, groups: role.groups, system: `${BASE_SYSTEM}\n${role.prompt}`, limits: { ...deps.limits, maxSteps: 15 } },
        { goal: String(a["task"]), signal: ctx.signal, taskId: `${randomUUID().slice(0, 4)}-${role.name}` },
      );
      const ok = rec.status === "completed";
      const verified = rec.steps.filter((s) => s.ok && s.verified).length;
      return {
        ok,
        output: `[${role.name}] status=${rec.status} steps=${rec.steps.length} verified=${verified} failed=${rec.steps.filter((s) => !s.ok).length}\n${rec.answer}`,
      };
    },
  };
}
