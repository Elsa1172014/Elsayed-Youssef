import { homedir } from "node:os";
import { join } from "node:path";
import { createDelegateTool } from "./agent/orchestrator.js";
import { runTask, summarize, type AgentEvent, type RunDeps, type TaskReport } from "./agent/loop.js";
import { TaskStore, type TaskRecord } from "./agent/store.js";
import { loadConfig, nexusHome, type NexusConfig, type ProviderConfig } from "./config.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { OpenAiCompatibleProvider } from "./llm/openai.js";
import { FallbackProvider } from "./llm/router.js";
import { McpHub } from "./mcp/hub.js";
import { AuditLog } from "./security/audit.js";
import { PermissionEngine, type Approver } from "./security/permissions.js";
import { desktopTools } from "./tools/desktop.js";
import { fileTools } from "./tools/files.js";
import { ToolRegistry } from "./tools/registry.js";
import { runCommandTool } from "./tools/shell.js";
import { systemTools } from "./tools/system.js";
import { webFetchTool } from "./tools/web.js";
import type { LlmProvider } from "./types.js";

export function buildProvider(cfgs: ProviderConfig[], env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const chain = cfgs.map((c): LlmProvider => {
    const key = c.apiKeyEnv ? env[c.apiKeyEnv] : undefined;
    if (c.apiKeyEnv && !key) throw new Error(`environment variable ${c.apiKeyEnv} is not set (provider ${c.name})`);
    return c.type === "anthropic"
      ? new AnthropicProvider(c.model, key ?? "", c.baseUrl)
      : new OpenAiCompatibleProvider(c.name, c.model, c.baseUrl ?? "https://api.openai.com/v1", key);
  });
  if (chain.length === 0) {
    throw new Error("No model provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY or OLLAMA_MODEL (or edit ~/.ai-nexus/config.json).");
  }
  return new FallbackProvider(chain);
}

export interface Runtime {
  config: NexusConfig;
  registry: ToolRegistry;
  hub: McpHub;
  store: TaskStore;
  audit: AuditLog;
  permissions: PermissionEngine;
  deps: RunDeps;
  run(goal: string, opts?: { signal?: AbortSignal; resumeId?: string; taskId?: string }): Promise<{ record: TaskRecord; report: TaskReport }>;
  close(): Promise<void>;
}

export async function createRuntime(opts: {
  approver: Approver;
  provider?: LlmProvider;
  config?: NexusConfig;
  cwd?: string;
  home?: string;
  onEvent?: (e: AgentEvent) => void;
  connectMcp?: boolean;
}): Promise<Runtime> {
  const config = opts.config ?? loadConfig();
  const home = opts.home ?? nexusHome();
  const cwd = opts.cwd ?? process.cwd();
  const audit = new AuditLog(join(home, "audit.jsonl"));
  const store = new TaskStore(join(home, "tasks.db"));
  const registry = new ToolRegistry();

  for (const t of [...fileTools, runCommandTool, ...systemTools, webFetchTool]) registry.register(t);
  if (process.platform === "win32") for (const t of desktopTools) registry.register(t);

  const permissions = new PermissionEngine(
    {
      mode: config.mode,
      allowedRoots: [cwd, join(homedir(), "Documents"), join(home, "workspace"), ...config.allowedRoots],
      deniedTools: config.deniedTools,
      allowedTools: config.allowedTools,
    },
    opts.approver,
    audit,
  );
  const hub = new McpHub(registry, audit);
  if (opts.connectMcp !== false) await hub.connectAll(config.mcpServers);

  let provider: LlmProvider;
  try {
    provider = opts.provider ?? buildProvider(config.providers);
  } catch (e) {
    // Keep the control center usable (status, MCP, audit); tasks fail with an actionable message.
    const message = (e as Error).message;
    provider = { id: "unconfigured", model: "none", complete: async () => { throw new Error(message); } };
  }
  const deps: RunDeps = {
    provider, registry, permissions, audit, store,
    ctx: { cwd, trashDir: join(home, "trash") },
    limits: { maxSteps: config.maxSteps },
    onEvent: opts.onEvent,
  };
  registry.register(createDelegateTool(deps));

  return {
    config, registry, hub, store, audit, permissions, deps,
    async run(goal, o = {}) {
      const record = await runTask(deps, { goal, signal: o.signal, resumeId: o.resumeId, taskId: o.taskId });
      return { record, report: summarize(record) };
    },
    async close() {
      await hub.disconnectAll();
      store.close();
    },
  };
}
