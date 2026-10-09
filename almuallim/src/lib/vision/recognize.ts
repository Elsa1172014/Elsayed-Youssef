import { normalizeArabic } from "@/lib/arabic/normalize";
import { toVectorLiteral, type EmbeddingProvider } from "@/lib/providers/embeddings";
import type { PageRecognizer } from "@/lib/providers/vision";
import type { RpcClient } from "@/lib/retrieval/search";
import { decideMatch, type MatchResult, type Observation, type PageCandidate } from "./page-match";

interface PageRow {
  page_id: string; page_number: number; printed_label: string | null; lesson_id: string | null; lesson_title: string | null;
  vector_similarity: number; trigram_similarity: number; lexical_score: number;
}

const MAX_QUERY_CHARS = 6000;

export async function findPageCandidates(
  deps: { db: RpcClient; embeddings: EmbeddingProvider },
  p: { versionId: string; text: string; limit?: number },
): Promise<{ candidates: PageCandidate[]; embeddingTokens: number }> {
  const text = normalizeArabic(p.text).slice(0, MAX_QUERY_CHARS);
  if (!text) return { candidates: [], embeddingTokens: 0 };
  const emb = await deps.embeddings.embed([text]);
  const { data, error } = await deps.db.rpc("match_pages", {
    p_query_embedding: toVectorLiteral(emb.vectors[0]!),
    p_query_text: text,
    p_book_version_id: p.versionId,
    p_limit: p.limit ?? 8,
  });
  if (error) throw new Error(`match_pages failed: ${error.message}`);
  const candidates = ((data as PageRow[] | null) ?? []).map((r) => ({
    pageNumber: r.page_number,
    printedLabel: r.printed_label,
    lessonId: r.lesson_id,
    lessonTitle: r.lesson_title,
    vectorSimilarity: Number(r.vector_similarity),
    trigramSimilarity: Number(r.trigram_similarity),
    lexicalScore: Number(r.lexical_score),
  }));
  return { candidates, embeddingTokens: emb.tokens };
}

export type RecognitionOutcome =
  | { status: "no_page"; observation: Observation; tokens: number; embeddingTokens: number }
  | { status: "matched"; observation: Observation; match: MatchResult; tokens: number; embeddingTokens: number };

/** Photo → OCR transcription → candidate pages from OUR index → decision with confidence. */
export async function recognizePage(
  deps: { db: RpcClient; embeddings: EmbeddingProvider; recognizer: PageRecognizer },
  p: { versionId: string; image: Uint8Array; mediaType: string; signal?: AbortSignal },
): Promise<RecognitionOutcome> {
  const { result, tokens } = await deps.recognizer.transcribe(p.image, p.mediaType, p.signal);
  const textChars = normalizeArabic(result.text).length;
  const observation: Observation = { printedPageNumber: result.printedPageNumber, textChars, legibility: result.legibility };
  if (!result.containsPageOfBook || textChars === 0) return { status: "no_page", observation, tokens, embeddingTokens: 0 };
  const { candidates, embeddingTokens } = await findPageCandidates(deps, { versionId: p.versionId, text: result.text });
  return { status: "matched", observation, match: decideMatch(candidates, observation), tokens, embeddingTokens };
}
