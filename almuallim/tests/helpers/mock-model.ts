import { MockLanguageModelV4 } from "ai/test";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

export const textTurn = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj) }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});

export const toolTurn = (toolName: string, input: unknown, toolCallId = "call_1") => ({
  content: [{ type: "tool-call" as const, toolCallId, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});

/** A scripted model: returns the given turns in order (one per model call). TEST-ONLY. */
export const scriptedModel = (turns: ReturnType<typeof textTurn | typeof toolTurn>[]) => new MockLanguageModelV4({ doGenerate: turns });
