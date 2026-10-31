import type { ChatMessage, LlmProvider, LlmResponse, ToolSpec } from "../types.js";

/** Tries providers in order; moves to the next only on provider errors, never on cancellation. */
export class FallbackProvider implements LlmProvider {
  constructor(private readonly chain: LlmProvider[]) {
    if (chain.length === 0) throw new Error("FallbackProvider needs at least one provider");
  }
  get id(): string { return this.chain.map((p) => p.id).join("|"); }
  get model(): string { return this.chain[0]!.model; }

  async complete(a: { system: string; messages: ChatMessage[]; tools: ToolSpec[]; signal: AbortSignal }): Promise<LlmResponse> {
    const errors: string[] = [];
    for (const p of this.chain) {
      try {
        return await p.complete(a);
      } catch (e) {
        if (a.signal.aborted) throw e;
        errors.push(`${p.id}/${p.model}: ${(e as Error).message}`);
      }
    }
    throw new Error(`all providers failed:\n${errors.join("\n")}`);
  }
}

/** Test/offline provider that replays a script of responses. */
export class ScriptedProvider implements LlmProvider {
  readonly id = "scripted";
  readonly model = "scripted";
  private i = 0;
  readonly seen: ChatMessage[][] = [];
  constructor(private readonly script: (LlmResponse | ((m: ChatMessage[]) => LlmResponse))[]) {}
  async complete(a: { messages: ChatMessage[] }): Promise<LlmResponse> {
    this.seen.push([...a.messages]);
    const step = this.script[Math.min(this.i++, this.script.length - 1)]!;
    return typeof step === "function" ? step(a.messages) : step;
  }
}
