import { readFileSync } from "node:fs";
import { normalizeArabic, tokenize } from "@/lib/arabic/normalize";
import { sha256Hex } from "@/lib/hash";
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "@/lib/providers/embeddings";
import type { PdfSource } from "@/lib/ingestion/ports";

export const fixturePath = (name: string) => new URL(`../fixtures/${name}`, import.meta.url);
export const readFixture = (name: string) => new Uint8Array(readFileSync(fixturePath(name)));
export const fixtureSha = (name: string) => sha256Hex(readFixture(name));

/**
 * TEST-ONLY deterministic embedding: hashed bag-of-words projected into 1536 dims and L2-normalised.
 * It is NOT semantic (no synonyms) — it only lets us test pipeline/DB mechanics with realistic vectors.
 */
export function makeFakeEmbedding(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const t of tokenize(normalizeArabic(text))) {
    const h = sha256Hex(t);
    const idx = parseInt(h.slice(0, 8), 16) % EMBEDDING_DIMENSIONS;
    v[idx]! += parseInt(h.slice(8, 10), 16) % 2 ? 1 : -1;
    v[(idx * 7 + 13) % EMBEDDING_DIMENSIONS]! += 0.5;
  }
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / n);
}

export class FakeEmbeddings implements EmbeddingProvider {
  readonly model = "fake-bow";
  calls = 0;
  textsEmbedded = 0;
  failOnCall: number | null = null;
  async embed(texts: string[]) {
    this.calls++;
    if (this.failOnCall === this.calls) throw new Error("simulated provider outage (503)");
    this.textsEmbedded += texts.length;
    return { vectors: texts.map(makeFakeEmbedding), tokens: texts.join("").length };
  }
}

export class FixturePdfSource implements PdfSource {
  constructor(private readonly files: Record<string, string>) {}
  async download(path: string) {
    const f = this.files[path];
    if (!f) throw new Error(`storage object not found: ${path}`);
    return readFixture(f);
  }
}
