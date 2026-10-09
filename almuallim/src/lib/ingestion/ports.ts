import type { ChunkDraft } from "./chunk";
import type { LessonDraft } from "./lessons";

/** Errors the worker must not retry (bad input, integrity failure). Everything else is retried with backoff. */
export class NonRetryableError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}
/** Thrown when this worker's lease was taken over; the job must be abandoned without marking it failed. */
export class LeaseLostError extends Error {
  constructor() {
    super("ingestion lease lost");
    this.name = "LeaseLostError";
  }
}

export interface VersionInfo {
  id: string;
  bookId: string;
  bookTitle: string;
  storagePath: string;
  fileSha256: string;
}

export interface PageRow {
  pageNumber: number;
  printedLabel: string | null;
  text: string;
  textNormalized: string;
  hasText: boolean;
  textSource: "text_layer" | "ocr";
  contentHash: string;
}

export interface ChunkRow extends ChunkDraft {
  lessonId: string | null;
}

export interface IngestionStore {
  getVersion(versionId: string): Promise<VersionInfo>;
  setPageCount(versionId: string, n: number): Promise<void>;
  upsertPages(versionId: string, rows: PageRow[]): Promise<void>;
  pagesMissingImages(versionId: string): Promise<number[]>;
  setPageImage(versionId: string, pageNumber: number, path: string): Promise<void>;
  pagesNeedingEmbedding(versionId: string, limit: number): Promise<{ pageNumber: number; text: string }[]>;
  setPageEmbeddings(versionId: string, rows: { pageNumber: number; vector: number[] }[]): Promise<void>;
  syncLessons(versionId: string, drafts: LessonDraft[]): Promise<Map<number, string>>;
  syncChunks(versionId: string, rows: ChunkRow[]): Promise<void>;
  chunksNeedingEmbedding(versionId: string, limit: number): Promise<{ id: string; embedText: string }[]>;
  setChunkEmbeddings(rows: { id: string; vector: number[] }[]): Promise<void>;
  recordUsage(userId: string, kind: "embedding_tokens" | "vision_calls", amount: number): Promise<void>;
}

export interface PdfSource {
  download(storagePath: string): Promise<Uint8Array>;
}

export interface PageImages {
  /** Render one page to PNG; null when no renderer is available (not an error: images are optional). */
  render(pdf: Uint8Array, pageNumber: number): Promise<Uint8Array | null>;
  put(versionId: string, pageNumber: number, png: Uint8Array): Promise<string>;
}

export interface PageOcr {
  /** Transcribe the printed text of a page image. */
  transcribe(png: Uint8Array): Promise<{ text: string }>;
}

export interface JobContext {
  jobId: string;
  versionId: string;
  requestedBy: string | null;
  /** Extends the lease and records progress; MUST throw LeaseLostError when the lease is gone. */
  checkpoint(stage: Stage, progress?: Record<string, unknown>): Promise<void>;
}

export type Stage = "download" | "extract" | "images" | "lessons" | "chunk" | "embed" | "finalize";
