import type { ChatMessage, LlmProvider, LlmResponse, ToolCall, ToolSpec } from "../types.js";

export function toOpenAiMessages(system: string, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
          : {}),
      });
    } else out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
  }
  return out;
}

/** Works with OpenAI, OpenRouter, Ollama (/v1), Gemini's OpenAI-compat endpoint, xAI, and any compatible server. */
export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    readonly id: string,
    readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  async complete(a: { system: string; messages: ChatMessage[]; tools: ToolSpec[]; signal: AbortSignal }): Promise<LlmResponse> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: a.signal,
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.model,
        messages: toOpenAiMessages(a.system, a.messages),
        ...(a.tools.length
          ? { tools: a.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
          : {}),
      }),
    });
    if (!res.ok) throw new Error(`${this.id} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = (await res.json()) as {
      choices: { message: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const msg = j.choices[0]?.message;
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((c) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = { __parse_error: c.function.arguments };
      }
      return { id: c.id, name: c.function.name, args };
    });
    return {
      content: msg?.content ?? "",
      toolCalls,
      usage: j.usage ? { inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens } : undefined,
    };
  }
}
