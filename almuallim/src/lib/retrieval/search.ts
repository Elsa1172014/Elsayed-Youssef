import type { EmbeddingProvider } from "@/lib/providers/embeddings";
import { toVectorLiteral } from "@/lib/providers/embeddings";
import { assessGrounding, type GroundingAssessment, type GroundingThresholds, type Passage, DEFAULT_THRESHOLDS } from "./grounding";
import { lexicalQueryText } from "./lexical";

/** The only part of a Supabase client retrieval needs (lets tests inject a fake without PostgREST). */
export interface RpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

interface Row {
  chunk_id: string;
  lesson_id: string | null;
  lesson_title: string | null;
  page_start: number;
  page_end: number;
  content: string;
  vector_similarity: number;
  lexical_score: number;
  fused_score: number;
}

export interface SearchResult {
  passages: Passage[];
  grounding: GroundingAssessment;
  embeddingTokens: number;
}

export async function searchTextbook(
  deps: { db: RpcClient; embeddings: EmbeddingProvider; thresholds?: GroundingThresholds },
  p: { query: string; versionId: string; lessonId?: string | null; limit?: number },
): Promise<SearchResult> {
  const query = p.query.trim().slice(0, 500);
  if (!query) return { passages: [], grounding: assessGrounding([]), embeddingTokens: 0 };
  const emb = await deps.embeddings.embed([query]);
  const { data, error } = await deps.db.rpc("search_content", {
    p_query_embedding: toVectorLiteral(emb.vectors[0]!),
    p_query_text: lexicalQueryText(query),
    p_book_version_id: p.versionId,
    p_lesson_id: p.lessonId ?? null,
    p_limit: Math.min(p.limit ?? 6, 12),
  });
  if (error) throw new Error(`search_content failed: ${error.message}`);
  const passages: Passage[] = ((data as Row[] | null) ?? []).map((r) => ({
    chunkId: r.chunk_id,
    lessonId: r.lesson_id,
    lessonTitle: r.lesson_title,
    pageStart: r.page_start,
    pageEnd: r.page_end,
    content: r.content,
    vectorSimilarity: Number(r.vector_similarity),
    lexicalScore: Number(r.lexical_score),
    fusedScore: Number(r.fused_score),
  }));
  return { passages, grounding: assessGrounding(passages, deps.thresholds ?? DEFAULT_THRESHOLDS), embeddingTokens: emb.tokens };
}
