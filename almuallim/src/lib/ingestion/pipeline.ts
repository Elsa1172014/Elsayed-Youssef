import { arabicRatio, normalizeArabic, stripControlChars } from "@/lib/arabic/normalize";
import { sha256Hex } from "@/lib/hash";
import type { Logger } from "@/lib/logger";
import type { EmbeddingProvider } from "@/lib/providers/embeddings";
import { chunkBook } from "./chunk";
import { extractOutline, extractPage, openPdf, type ExtractedPage } from "./extract";
import { detectLessons } from "./lessons";
import {
  NonRetryableError,
  type IngestionStore,
  type JobContext,
  type PageImages,
  type PageOcr,
  type PageRow,
  type PdfSource,
} from "./ports";

export interface IngestionPorts {
  store: IngestionStore;
  pdf: PdfSource;
  embeddings: EmbeddingProvider;
  images?: PageImages;
  ocr?: PageOcr;
  log: Logger;
}

export interface IngestionSummary {
  pages: number;
  pagesWithText: number;
  pagesOcr: number;
  pagesReversedFixed: number;
  lowArabicPages: number[];
  lessons: number;
  chunks: number;
  chunksEmbedded: number;
  pagesEmbedded: number;
  imagesRendered: number;
  warnings: string[];
}

const PAGE_BATCH = 25;
const EMBED_BATCH = 64;
const MAX_PAGE_EMBED_CHARS = 6000;

/**
 * Resumable, idempotent ingestion. Every stage is safe to re-run: pages/lessons/chunks are upserted by
 * natural keys, and paid steps (embeddings, OCR, images) only process rows that are still missing.
 */
export async function runIngestion(ctx: JobContext, ports: IngestionPorts): Promise<IngestionSummary> {
  const { store, log } = ports;
  const warnings: string[] = [];
  const v = await store.getVersion(ctx.versionId);

  // ── download + integrity ─────────────────────────────────────────────
  await ctx.checkpoint("download");
  const bytes = await ports.pdf.download(v.storagePath);
  if (sha256Hex(bytes) !== v.fileSha256) {
    throw new NonRetryableError("PDF checksum does not match the recorded upload hash (corrupt or replaced file)");
  }
  let doc;
  try {
    doc = await openPdf(bytes);
  } catch (e) {
    throw new NonRetryableError(`Unreadable PDF: ${(e as Error).message}`);
  }
  const total = doc.numPages;
  if (total < 1) throw new NonRetryableError("PDF has no pages");
  await store.setPageCount(v.id, total);

  // ── extract (text layer, optional OCR for scanned pages) ──────────────
  const extracted: ExtractedPage[] = [];
  const rows: PageRow[] = [];
  const ocrPages = new Set<number>();
  const flush = async () => {
    if (rows.length) await store.upsertPages(v.id, rows.splice(0));
  };
  for (let n = 1; n <= total; n++) {
    let page = await extractPage(doc, n);
    let source: PageRow["textSource"] = "text_layer";
    if (!page.hasText && ports.ocr && ports.images) {
      const png = await ports.images.render(bytes, n);
      if (png) {
        const text = stripControlChars((await ports.ocr.transcribe(png)).text);
        if (ctx.requestedBy) await store.recordUsage(ctx.requestedBy, "vision_calls", 1);
        const norm = normalizeArabic(text);
        if (norm.length >= 20) {
          page = { ...page, text: text.trim(), textNormalized: norm, hasText: true, lines: [] };
          source = "ocr";
          ocrPages.add(n);
        }
      }
    }
    extracted.push(page);
    rows.push({
      pageNumber: n,
      printedLabel: page.printedLabel,
      text: page.text,
      textNormalized: page.textNormalized,
      hasText: page.hasText,
      textSource: source,
      contentHash: sha256Hex(page.textNormalized),
    });
    if (rows.length >= PAGE_BATCH) {
      await flush();
      await ctx.checkpoint("extract", { pages_total: total, pages_done: n });
    }
  }
  await flush();
  await ctx.checkpoint("extract", { pages_total: total, pages_done: total });

  const withText = extracted.filter((p) => p.hasText);
  const lowArabic = withText.filter((p) => !ocrPages.has(p.pageNumber) && arabicRatio(p.text) < 0.5).map((p) => p.pageNumber);
  const reversed = extracted.filter((p) => p.reversedFixed).length;
  if (withText.length === 0) {
    throw new NonRetryableError(
      "No extractable text in this PDF (scanned images). Re-run with INGEST_OCR=1 and a vision provider key, or upload a text-layer PDF.",
    );
  }
  if (withText.length / total < 0.7) warnings.push(`only ${withText.length}/${total} pages have text; the rest need OCR`);
  if (lowArabic.length > total * 0.3) warnings.push(`${lowArabic.length} pages have low Arabic ratio; check extraction quality`);
  if (reversed) warnings.push(`${reversed} pages were in visual order and were repaired; spot-check them`);

  // ── page images (optional) ───────────────────────────────────────────
  let imagesRendered = 0;
  if (ports.images) {
    const missing = await store.pagesMissingImages(v.id);
    for (const n of missing) {
      const png = await ports.images.render(bytes, n);
      if (!png) {
        warnings.push("page image renderer unavailable; skipped page images");
        break;
      }
      const path = await ports.images.put(v.id, n, png);
      await store.setPageImage(v.id, n, path);
      imagesRendered++;
      if (imagesRendered % 10 === 0) await ctx.checkpoint("images", { images_done: imagesRendered, images_total: missing.length });
    }
  }
  await ctx.checkpoint("images", { images_done: imagesRendered });

  // ── lessons ──────────────────────────────────────────────────────────
  await ctx.checkpoint("lessons");
  const outline = await extractOutline(doc);
  const drafts = detectLessons({ outline, pages: extracted, fallbackTitle: v.bookTitle });
  if (drafts.length === 1 && drafts[0]!.method === "whole_document") {
    warnings.push("no lesson boundaries detected; whole book is one lesson (a teacher should split it)");
  }
  const lessonIds = await store.syncLessons(v.id, drafts);

  // ── chunks ───────────────────────────────────────────────────────────
  await ctx.checkpoint("chunk", { lessons: drafts.length });
  const chunks = chunkBook(extracted, drafts);
  await store.syncChunks(
    v.id,
    chunks.map((c) => ({ ...c, lessonId: c.lessonOrdinal == null ? null : (lessonIds.get(c.lessonOrdinal) ?? null) })),
  );
  await ctx.checkpoint("chunk", { lessons: drafts.length, chunks: chunks.length });

  // ── embeddings (only what is missing) ────────────────────────────────
  let chunksEmbedded = 0;
  let pagesEmbedded = 0;
  for (;;) {
    const batch = await store.chunksNeedingEmbedding(v.id, EMBED_BATCH);
    if (!batch.length) break;
    const r = await ports.embeddings.embed(batch.map((b) => b.embedText));
    await store.setChunkEmbeddings(batch.map((b, i) => ({ id: b.id, vector: r.vectors[i]! })));
    if (ctx.requestedBy) await store.recordUsage(ctx.requestedBy, "embedding_tokens", r.tokens);
    chunksEmbedded += batch.length;
    await ctx.checkpoint("embed", { chunks_embedded: chunksEmbedded, chunks_total: chunks.length });
  }
  for (;;) {
    const batch = await store.pagesNeedingEmbedding(v.id, EMBED_BATCH);
    if (!batch.length) break;
    const r = await ports.embeddings.embed(batch.map((b) => b.text.slice(0, MAX_PAGE_EMBED_CHARS)));
    await store.setPageEmbeddings(v.id, batch.map((b, i) => ({ pageNumber: b.pageNumber, vector: r.vectors[i]! })));
    if (ctx.requestedBy) await store.recordUsage(ctx.requestedBy, "embedding_tokens", r.tokens);
    pagesEmbedded += batch.length;
    await ctx.checkpoint("embed", { pages_embedded: pagesEmbedded, chunks_embedded: chunksEmbedded });
  }

  const summary: IngestionSummary = {
    pages: total,
    pagesWithText: withText.length,
    pagesOcr: ocrPages.size,
    pagesReversedFixed: reversed,
    lowArabicPages: lowArabic,
    lessons: drafts.length,
    chunks: chunks.length,
    chunksEmbedded,
    pagesEmbedded,
    imagesRendered,
    warnings,
  };
  await ctx.checkpoint("finalize", { summary });
  log.info("ingestion complete", { versionId: v.id, ...summary });
  return summary;
}
