import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "./mcp/hub.js";
import type { PermissionMode } from "./security/permissions.js";

export interface ProviderConfig {
  type: "anthropic" | "openai";
  /** Free label: openai, openrouter, ollama, gemini, xai … */
  name: string;
  model: string;
  baseUrl?: string;
  /** Name of the environment variable holding the key. Keys are never stored in config files. */
  apiKeyEnv?: string;
}

export interface NexusConfig {
  mode: PermissionMode;
  /** Extra directories the agent may touch (workspace + Documents are added automatically). */
  allowedRoots: string[];
  deniedTools: string[];
  allowedTools: string[];
  providers: ProviderConfig[];
  mcpServers: Record<string, McpServerConfig>;
  maxSteps: number;
}

export function nexusHome(): string {
  return process.env["NEXUS_HOME"] ?? join(homedir(), ".ai-nexus");
}

export function defaultProviders(env: NodeJS.ProcessEnv = process.env): ProviderConfig[] {
  const list: ProviderConfig[] = [];
  if (env["ANTHROPIC_API_KEY"]) list.push({ type: "anthropic", name: "anthropic", model: env["NEXUS_ANTHROPIC_MODEL"] ?? "claude-sonnet-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" });
  if (env["OPENAI_API_KEY"]) list.push({ type: "openai", name: "openai", model: env["NEXUS_OPENAI_MODEL"] ?? "gpt-4.1", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" });
  if (env["OPENROUTER_API_KEY"]) list.push({ type: "openai", name: "openrouter", model: env["NEXUS_OPENROUTER_MODEL"] ?? "anthropic/claude-sonnet-4.5", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" });
  if (env["OLLAMA_MODEL"]) list.push({ type: "openai", name: "ollama", model: env["OLLAMA_MODEL"], baseUrl: env["OLLAMA_URL"] ?? "http://127.0.0.1:11434/v1" });
  return list;
}

export function loadConfig(): NexusConfig {
  const file = join(nexusHome(), "config.json");
  mkdirSync(nexusHome(), { recursive: true });
  const user: Partial<NexusConfig> = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<NexusConfig>) : {};
  const providers = user.providers?.length ? user.providers : defaultProviders();
  return {
    mode: user.mode ?? "ask",
    allowedRoots: user.allowedRoots ?? [],
    deniedTools: user.deniedTools ?? [],
    allowedTools: user.allowedTools ?? [],
    providers,
    mcpServers: user.mcpServers ?? {},
    maxSteps: user.maxSteps ?? 25,
  };
}
