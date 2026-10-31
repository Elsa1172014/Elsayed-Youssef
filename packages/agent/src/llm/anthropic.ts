import type { ChatMessage, LlmProvider, LlmResponse, ToolCall, ToolSpec } from "../types.js";

interface Block { type: string; [k: string]: unknown }

/** Convert neutral messages to Anthropic format; consecutive tool results merge into one user turn. */
export function toAnthropicMessages(messages: ChatMessage[]): { role: "user" | "assistant"; content: string | Block[] }[] {
  const out: { role: "user" | "assistant"; content: string | Block[] }[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      out.push({ role: "assistant", content: blocks.length ? blocks : m.content });
    } else {
      const block: Block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content, is_error: m.isError === true };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic";
  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.anthropic.com",
  ) {}

  async complete(a: { system: string; messages: ChatMessage[]; tools: ToolSpec[]; signal: AbortSignal }): Promise<LlmResponse> {
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      signal: a.signal,
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: a.system,
        messages: toAnthropicMessages(a.messages),
        tools: a.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = (await res.json()) as { content: Block[]; usage?: { input_tokens: number; output_tokens: number } };
    let content = "";
    const toolCalls: ToolCall[] = [];
    for (const b of j.content) {
      if (b.type === "text") content += String(b["text"]);
      if (b.type === "tool_use") toolCalls.push({ id: String(b["id"]), name: String(b["name"]), args: (b["input"] ?? {}) as Record<string, unknown> });
    }
    return {
      content,
      toolCalls,
      usage: j.usage ? { inputTokens: j.usage.input_tokens, outputTokens: j.usage.output_tokens } : undefined,
    };
  }
}
