import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assembleLines } from "@/lib/ingestion/layout";
import { extractOutline, extractPage, openPdf } from "@/lib/ingestion/extract";
import { normalizeArabic } from "@/lib/arabic/normalize";

const fixture = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${n}`, import.meta.url)));

describe("assembleLines (synthetic glyph runs)", () => {
  it("drops NUL / control characters that PostgreSQL would reject", () => {
    const lines = assembleLines([{ str: "كتا\u0000ب\u0001", x: 10, y: 10, width: 30, height: 12 }]);
    expect(lines[0]!.text).toBe("كتاب");
  });
  it("puts RTL glyphs in logical order, keeps digit runs intact, and groups by line", () => {
    const mk = (str: string, x: number, y = 100) => ({ str, x, y, width: 8, height: 12 });
    // Visual left→right: ب ت ك (last letter leftmost), space, then digits "12" drawn left→right.
    const lines = assembleLines([mk("ب", 10), mk("ت", 20), mk("ك", 30), mk(" ", 40), mk("1", 50), mk("2", 58), mk("ع", 10, 60)]);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.text).toBe("12 كتب");
    expect(lines[1]!.text).toBe("ع");
  });
  it("places a diacritic after its base letter", () => {
    const items = [
      { str: "ب", x: 10, y: 50, width: 8, height: 12 },
      { str: "ت", x: 20, y: 50, width: 8, height: 12 },
      { str: "ك", x: 30, y: 50, width: 8, height: 12 },
      { str: "َ", x: 31, y: 56, width: 3, height: 6 }, // fatha above ك
    ];
    expect(assembleLines(items)[0]!.text).toBe("كَتب");
  });
});

describe("real PDF extraction (Chromium-generated Arabic fixture)", () => {
  it("extracts logical-order, searchable Arabic text per page", async () => {
    const doc = await openPdf(fixture("sample-textbook.pdf"));
    expect(doc.numPages).toBe(6);
    const p2 = await extractPage(doc, 2);
    expect(p2.hasText).toBe(true);
    expect(p2.textNormalized).toContain(normalizeArabic("الفاعل اسم مرفوع"));
    expect(p2.textNormalized).toContain(normalizeArabic("الدرس الأول"));
    expect(p2.printedLabel).toBe("2");
    expect(p2.text).not.toMatch(/[ﭐ-﷿ﹰ-﻿]/); // presentation forms folded
  });
  it("reads the outline and resolves page numbers", async () => {
    const doc = await openPdf(fixture("sample-textbook.pdf"));
    const ol = await extractOutline(doc);
    expect(ol.length).toBeGreaterThanOrEqual(5);
    const lesson1 = ol.find((o) => normalizeArabic(o.title).includes(normalizeArabic("الدرس الأول")));
    expect(lesson1?.pageNumber).toBe(2);
    const noOutline = await extractOutline(await openPdf(fixture("sample-textbook-noutline.pdf")));
    expect(noOutline).toEqual([]);
  });
});
