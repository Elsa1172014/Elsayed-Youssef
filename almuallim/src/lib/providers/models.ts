import "server-only";
import { createOpenAI } from "@ai-sdk/openai";
import { serverEnv } from "@/lib/env";
import { createOpenAIEmbeddings, type EmbeddingProvider } from "./embeddings";
import { createOpenAIRecognizer, type PageRecognizer } from "./vision";

/** Central factory for provider-backed models. Routes depend on these, tests mock this module. */
export function getTutorModel() {
  const env = serverEnv();
  return createOpenAI({ apiKey: env.OPENAI_API_KEY })(env.TUTOR_MODEL);
}
export function getEmbeddings(): EmbeddingProvider {
  const env = serverEnv();
  return createOpenAIEmbeddings({ apiKey: env.OPENAI_API_KEY, model: env.EMBEDDING_MODEL });
}
export function getRecognizer(): PageRecognizer {
  const env = serverEnv();
  return createOpenAIRecognizer({ apiKey: env.OPENAI_API_KEY, model: env.VISION_MODEL });
}
