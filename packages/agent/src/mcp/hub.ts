import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuditLog } from "../security/audit.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { JsonSchema, RiskLevel, Tool } from "../types.js";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** Tools (original names) known to be read-only; they run as low risk. Everything else is medium. */
  readOnlyTools?: string[];
  /** Tools that change or send things externally; always high risk. */
  highRiskTools?: string[];
  /**
   * Argument-aware risk. First matching rule wins (case-insensitive); otherwise the tool-level
   * classification (readOnlyTools / highRiskTools / default medium) applies.
   */
  riskRules?: RiskRule[];
  disabled?: boolean;
}

export interface RiskRule {
  tool: string;
  /** Argument name inspected, e.g. "action". */
  arg: string;
  /** Values (case-insensitive) that select this rule. */
  in: string[];
  risk: RiskLevel;
}

export function ruleRisk(cfg: McpServerConfig, tool: string, args: Record<string, unknown>): RiskLevel | undefined {
  for (const r of cfg.riskRules ?? []) {
    if (r.tool !== tool) continue;
    const v = args[r.arg];
    if (typeof v === "string" && r.in.some((x) => x.toLowerCase() === v.toLowerCase())) return r.risk;
  }
  return undefined;
}

export interface McpServerStatus {
  name: string;
  connected: boolean;
  tools: string[];
  error?: string;
}

const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "_");

export class McpHub {
  private readonly clients = new Map<string, Client>();
  private readonly status = new Map<string, McpServerStatus>();

  constructor(private readonly registry: ToolRegistry, private readonly audit: AuditLog) {}

  async connectAll(servers: Record<string, McpServerConfig>): Promise<McpServerStatus[]> {
    await Promise.all(Object.entries(servers).map(([n, c]) => this.connect(n, c)));
    return this.list();
  }

  async connect(name: string, cfg: McpServerConfig): Promise<McpServerStatus> {
    await this.disconnect(name);
    if (cfg.disabled) return this.set({ name, connected: false, tools: [], error: "disabled" });
    try {
      const transport = cfg.url
        ? new StreamableHTTPClientTransport(new URL(cfg.url))
        : new StdioClientTransport({
            command: cfg.command ?? "",
            args: cfg.args ?? [],
            // Do not leak the parent's secrets into third-party servers; pass only what the config names.
            env: { ...safeBaseEnv(), ...(cfg.env ?? {}) },
          });
      const client = new Client({ name: "ai-nexus", version: "0.1.0" });
      await client.connect(transport);
      const { tools } = await client.listTools();
      this.clients.set(name, client);
      const prefix = `mcp__${safe(name)}__`;
      for (const t of tools) this.registry.register(this.wrap(client, prefix, name, t, cfg));
      this.audit.write({ kind: "mcp", detail: `connected ${name}: ${tools.map((t) => t.name).join(", ")}` });
      return this.set({ name, connected: true, tools: tools.map((t) => prefix + t.name) });
    } catch (e) {
      this.audit.write({ kind: "mcp", detail: `connect failed ${name}: ${(e as Error).message}` });
      return this.set({ name, connected: false, tools: [], error: (e as Error).message });
    }
  }

  async disconnect(name: string): Promise<void> {
    this.registry.unregisterPrefix(`mcp__${safe(name)}__`);
    const c = this.clients.get(name);
    this.clients.delete(name);
    this.status.delete(name);
    if (c) await c.close().catch(() => undefined);
  }

  async disconnectAll(): Promise<void> {
    for (const n of [...this.clients.keys()]) await this.disconnect(n);
  }

  /** Health check: ping every connected server. */
  async health(): Promise<{ name: string; ok: boolean }[]> {
    return Promise.all(
      [...this.clients].map(async ([name, c]) => ({ name, ok: await c.ping().then(() => true, () => false) })),
    );
  }

  list(): McpServerStatus[] { return [...this.status.values()]; }

  private set(s: McpServerStatus): McpServerStatus { this.status.set(s.name, s); return s; }

  private wrap(
    client: Client,
    prefix: string,
    server: string,
    t: { name: string; description?: string; inputSchema: unknown },
    cfg: McpServerConfig,
  ): Tool {
    const risk: RiskLevel = cfg.highRiskTools?.includes(t.name) ? "high" : cfg.readOnlyTools?.includes(t.name) ? "low" : "medium";
    return {
      name: prefix + t.name,
      group: "mcp",
      description: `[MCP:${server}] ${t.description ?? t.name}`,
      inputSchema: normalizeSchema(t.inputSchema),
      risk: (a) => ruleRisk(cfg, t.name, a) ?? risk,
      describeCall: (a) => `MCP ${server}.${t.name}(${JSON.stringify(a).slice(0, 160)})`,
      run: async (a, ctx) => {
        const r = await client.callTool({ name: t.name, arguments: a }, undefined, { signal: ctx.signal });
        const parts = Array.isArray(r.content) ? r.content : [];
        const text = parts.map((p: { type: string; text?: string }) => (p.type === "text" ? p.text ?? "" : `[${p.type}]`)).join("\n");
        return { ok: r.isError !== true, output: text };
      },
    };
  }
}

function safeBaseEnv(): Record<string, string> {
  const keep = ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "LANG"];
  const out: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) out[k] = process.env[k]!;
  return out;
}

function normalizeSchema(raw: unknown): JsonSchema {
  const s = (raw ?? {}) as Partial<JsonSchema>;
  return { type: "object", properties: s.properties ?? {}, ...(s.required ? { required: s.required } : {}) };
}
