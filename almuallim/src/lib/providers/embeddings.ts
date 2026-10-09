import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";

export const EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingResult {
  vectors: number[][];
  tokens: number;
}

/** Provider boundary: swap implementations without touching ingestion or retrieval. */
export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult>;
}

export function createOpenAIEmbeddings(opts: { apiKey: string; model?: string }): EmbeddingProvider {
  const model = opts.model ?? "text-embedding-3-small";
  const openai = createOpenAI({ apiKey: opts.apiKey });
  return {
    model,
    async embed(texts, signal) {
      if (texts.length === 0) return { vectors: [], tokens: 0 };
      const r = await embedMany({ model: openai.embedding(model), values: texts, abortSignal: signal, maxRetries: 3 });
      for (const v of r.embeddings) {
        if (v.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(`Embedding dimension ${v.length} != ${EMBEDDING_DIMENSIONS}; the schema is vector(${EMBEDDING_DIMENSIONS}).`);
        }
      }
      return { vectors: r.embeddings, tokens: r.usage?.tokens ?? 0 };
    },
  };
}

/** pgvector text literal. */
export const toVectorLiteral = (v: number[]): string => `[${v.join(",")}]`;
