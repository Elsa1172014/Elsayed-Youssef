import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractOutline, extractPage, openPdf, type ExtractedPage } from "@/lib/ingestion/extract";
import { detectLessons } from "@/lib/ingestion/lessons";

const fixture = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${n}`, import.meta.url)));
async function load(name: string) {
  const doc = await openPdf(fixture(name));
  const pages: ExtractedPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push(await extractPage(doc, i));
  return { pages, outline: await extractOutline(doc) };
}

describe("detectLessons", () => {
  it("uses the PDF outline when present", async () => {
    const { pages, outline } = await load("sample-textbook.pdf");
    const lessons = detectLessons({ outline, pages, fallbackTitle: "كتاب" });
    expect(lessons.map((l) => [l.title, l.startPage, l.endPage, l.method])).toEqual([
      ["الدرس الأول: الفاعل", 2, 3, "outline"],
      ["الدرس الثاني: المفعول به", 4, 5, "outline"],
      ["الدرس الثالث: نص شعري — العلم نور", 6, 6, "outline"],
    ]);
    expect(lessons[0]!.unitTitle).toContain("الوحدة الأولى");
  });

  it("falls back to font-size heading heuristics without an outline", async () => {
    const { pages, outline } = await load("sample-textbook-noutline.pdf");
    expect(outline).toEqual([]);
    const lessons = detectLessons({ outline, pages, fallbackTitle: "كتاب" });
    expect(lessons.map((l) => [l.startPage, l.endPage, l.method])).toEqual([[2, 3, "heading"], [4, 5, "heading"], [6, 6, "heading"]]);
    expect(lessons[0]!.title).toContain("الدرس الأول");
    expect(lessons[0]!.unitTitle).toContain("الوحدة الأولى");
  });

  it("falls back to a single whole-document lesson when nothing is detectable", () => {
    const page = (n: number): ExtractedPage => ({ pageNumber: n, lines: [], text: "نص", textNormalized: "نص", hasText: true, printedLabel: null, medianFont: 12, reversedFixed: false });
    const lessons = detectLessons({ outline: [], pages: [page(1), page(2), page(3)], fallbackTitle: "كتاب القراءة" });
    expect(lessons).toEqual([{ ordinal: 0, title: "كتاب القراءة", unitTitle: null, startPage: 1, endPage: 3, method: "whole_document" }]);
  });

  it("uses the shallowest multi-entry outline level when titles carry no lesson keywords", () => {
    const page = (n: number): ExtractedPage => ({ pageNumber: n, lines: [], text: "x", textNormalized: "x", hasText: true, printedLabel: null, medianFont: 12, reversedFixed: false });
    const outline = [
      { title: "المقدمة", pageNumber: 1, depth: 0 },
      { title: "الأسرة", pageNumber: 3, depth: 0 },
      { title: "تمرين", pageNumber: 4, depth: 1 },
      { title: "الوطن", pageNumber: 6, depth: 0 },
    ];
    const lessons = detectLessons({ outline, pages: [1, 2, 3, 4, 5, 6, 7, 8].map(page), fallbackTitle: "ك" });
    expect(lessons.map((l) => [l.title, l.startPage, l.endPage])).toEqual([["المقدمة", 1, 2], ["الأسرة", 3, 5], ["الوطن", 6, 8]]);
  });
});
