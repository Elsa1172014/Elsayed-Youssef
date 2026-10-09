import { describe, expect, it } from "vitest";
import { chunkBook, lessonOrdinalForPage } from "@/lib/ingestion/chunk";
import type { ExtractedPage } from "@/lib/ingestion/extract";
import type { LessonDraft } from "@/lib/ingestion/lessons";
import { normalizeArabic } from "@/lib/arabic/normalize";

const sentence = (i: number) => `هذه الجملة رقم ${i} تشرح فكرة نحوية مهمة للطلاب في هذا الدرس بأسلوب واضح ومباشر.`;
const page = (n: number, sentences: number[], hasText = true): ExtractedPage => {
  const text = sentences.map(sentence).join(" ");
  return { pageNumber: n, lines: [], text, textNormalized: normalizeArabic(text), hasText, printedLabel: String(n), medianFont: 12, reversedFixed: false };
};
const lessons: LessonDraft[] = [
  { ordinal: 0, title: "الدرس الأول", unitTitle: null, startPage: 2, endPage: 3, method: "outline" },
  { ordinal: 1, title: "الدرس الثاني", unitTitle: null, startPage: 4, endPage: 5, method: "outline" },
];
const pages = [
  page(1, [0, 1, 2]),
  page(2, Array.from({ length: 14 }, (_, i) => i)),
  page(3, Array.from({ length: 14 }, (_, i) => 20 + i)),
  page(4, Array.from({ length: 10 }, (_, i) => 40 + i)),
  page(5, [60, 61], false),
];

describe("chunkBook", () => {
  const chunks = chunkBook(pages, lessons);
  it("never crosses lesson boundaries and keeps page ranges inside the lesson", () => {
    for (const c of chunks) {
      if (c.lessonOrdinal == null) continue;
      const l = lessons[c.lessonOrdinal]!;
      expect(c.pageStart).toBeGreaterThanOrEqual(l.startPage);
      expect(c.pageEnd).toBeLessThanOrEqual(l.endPage);
      expect(c.pageEnd).toBeGreaterThanOrEqual(c.pageStart);
    }
    expect(chunks.some((c) => c.lessonOrdinal === 0)).toBe(true);
    expect(chunks.some((c) => c.lessonOrdinal === 1)).toBe(true);
    expect(chunks[0]!.lessonOrdinal).toBeNull(); // front matter page 1
  });
  it("respects the max size, numbers chunks consecutively, and skips pages without text", () => {
    chunks.forEach((c, i) => {
      expect(c.ordinal).toBe(i);
      expect(c.tokenEstimate).toBeLessThanOrEqual(700);
    });
    expect(chunks.every((c) => c.pageStart !== 5 && c.pageEnd !== 5)).toBe(true);
  });
  it("is deterministic (idempotent re-runs) and hashes differ for different content", () => {
    expect(chunkBook(pages, lessons)).toEqual(chunks);
    expect(new Set(chunks.map((c) => c.contentHash)).size).toBe(chunks.length);
  });
  it("loses no text: every sentence of a lesson is present in exactly the lesson's chunks", () => {
    const l0 = chunks.filter((c) => c.lessonOrdinal === 0).map((c) => c.content).join(" ");
    for (let i = 0; i < 14; i++) expect(l0).toContain(sentence(i));
    for (let i = 20; i < 34; i++) expect(l0).toContain(sentence(i));
  });
  it("prefixes embedText with the lesson title but keeps content verbatim", () => {
    const c = chunks.find((x) => x.lessonOrdinal === 1)!;
    expect(c.embedText.startsWith("الدرس الثاني\n")).toBe(true);
    expect(c.content.startsWith("الدرس")).toBe(false);
  });
  it("does not emit stub chunks", () => {
    const small = chunkBook([page(2, [0])], lessons);
    expect(small).toHaveLength(1);
    const withTail = chunkBook([page(2, Array.from({ length: 9 }, (_, i) => i)), page(3, [99])], lessons);
    expect(withTail.at(-1)!.content).toContain(sentence(99));
    expect(withTail.every((c) => c.content.length > 50)).toBe(true);
  });
  it("splits an over-long unbroken paragraph", () => {
    const long = Array.from({ length: 80 }, (_, i) => sentence(i)).join(" ");
    const p: ExtractedPage = { ...page(2, []), text: long, textNormalized: normalizeArabic(long) };
    const out = chunkBook([p], lessons);
    expect(out.length).toBeGreaterThan(3);
    expect(out.every((c) => c.tokenEstimate <= 700)).toBe(true);
  });
  it("maps pages to lessons", () => {
    expect(lessonOrdinalForPage(lessons, 1)).toBeNull();
    expect(lessonOrdinalForPage(lessons, 3)).toBe(0);
    expect(lessonOrdinalForPage(lessons, 4)).toBe(1);
  });
});
