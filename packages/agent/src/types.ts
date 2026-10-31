export type RiskLevel = "low" | "medium" | "high";

export interface ToolContext {
  /** Aborts the running tool when the task is cancelled. */
  signal: AbortSignal;
  /** Working directory sandbox root for relative paths. */
  cwd: string;
  /** Directory where recoverable deletions are moved. */
  trashDir: string;
}

export interface ToolResult {
  ok: boolean;
  /** Text returned to the model. */
  output: string;
  /** True only when the tool itself verified the outcome (e.g. file exists after write). */
  verified?: boolean;
  data?: unknown;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Risk is computed per call so the same tool can be low or high depending on args. */
  risk(args: Record<string, unknown>, ctx: ToolContext): RiskLevel;
  /** Short human-readable description of what this call will do (shown in approvals). */
  describeCall(args: Record<string, unknown>): string;
  /** Filesystem paths touched by this call, checked against the sandbox. */
  paths?(args: Record<string, unknown>, ctx: ToolContext): string[];
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  group: "files" | "documents" | "shell" | "system" | "desktop" | "mcp" | "agent";
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface LlmResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  complete(args: {
    system: string;
    messages: ChatMessage[];
    tools: ToolSpec[];
    signal: AbortSignal;
  }): Promise<LlmResponse>;
}
