import { normalizeArabic } from "@/lib/arabic/normalize";
import { median } from "./layout";
import type { ExtractedPage, OutlineEntry } from "./extract";

export interface LessonDraft {
  ordinal: number;
  title: string;
  unitTitle: string | null;
  startPage: number;
  endPage: number;
  method: "outline" | "heading" | "whole_document";
}

const LESSON_RE = /^(الدرس|درس|النص|القراءه|lesson)(\s|$)/i;
const UNIT_RE = /^(الوحده|وحده|الباب|الفصل|المحور|unit|chapter)(\s|$)/i;

export const isLessonTitle = (t: string) => LESSON_RE.test(normalizeArabic(t));
export const isUnitTitle = (t: string) => UNIT_RE.test(normalizeArabic(t));

interface Marker {
  kind: "lesson" | "unit";
  title: string;
  page: number;
  order: number;
}

function finalize(markers: Marker[], lastPage: number, method: LessonDraft["method"]): LessonDraft[] {
  const sorted = [...markers].sort((a, b) => a.page - b.page || a.order - b.order);
  const lessons: Marker[] = sorted.filter((m) => m.kind === "lesson");
  const drafts: LessonDraft[] = [];
  let unit: string | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < lessons.length; i++) {
    const cur = lessons[i]!;
    // latest unit marker at or before this lesson (same page: only if it came first)
    unit =
      [...sorted].reverse().find((m) => m.kind === "unit" && (m.page < cur.page || (m.page === cur.page && m.order < cur.order)))
        ?.title ?? null;
    const key = `${cur.page}|${normalizeArabic(cur.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const next = lessons.slice(i + 1).find((n) => n.page > cur.page || normalizeArabic(n.title) !== normalizeArabic(cur.title));
    const end = next ? Math.max(cur.page, next.page > cur.page ? next.page - 1 : cur.page) : lastPage;
    drafts.push({ ordinal: drafts.length, title: cur.title, unitTitle: unit, startPage: cur.page, endPage: end, method });
  }
  return drafts;
}

function fromOutline(outline: OutlineEntry[], lastPage: number): LessonDraft[] {
  const usable = outline.filter((o) => o.pageNumber != null && o.title);
  const markers: Marker[] = [];
  usable.forEach((o, i) => {
    if (isLessonTitle(o.title)) markers.push({ kind: "lesson", title: o.title, page: o.pageNumber!, order: i });
    else if (isUnitTitle(o.title)) markers.push({ kind: "unit", title: o.title, page: o.pageNumber!, order: i });
  });
  if (markers.some((m) => m.kind === "lesson")) return finalize(markers, lastPage, "outline");

  // No keywords: fall back to the shallowest outline level that has at least two entries.
  const depths = [...new Set(usable.map((o) => o.depth))].sort((a, b) => a - b);
  for (const d of depths) {
    const level = usable.filter((o) => o.depth === d);
    if (level.length >= 2) {
      return finalize(
        level.map((o, i) => ({ kind: "lesson" as const, title: o.title, page: o.pageNumber!, order: i })),
        lastPage,
        "outline",
      );
    }
  }
  return [];
}

function fromHeadings(pages: ExtractedPage[], lastPage: number): LessonDraft[] {
  const body = median(pages.filter((p) => p.hasText).map((p) => p.medianFont));
  if (!body) return [];
  const markers: Marker[] = [];
  let order = 0;
  for (const p of pages) {
    const big = p.lines.filter((l) => l.fontSize >= body * 1.25 && l.text.length <= 120);
    for (let i = 0; i < big.length; i++) {
      let title = big[i]!.text;
      // A heading wrapped over several lines keeps the same size on adjacent lines.
      const lineIdx = p.lines.indexOf(big[i]!);
      let j = lineIdx;
      while (p.lines[j + 1] && Math.abs(p.lines[j + 1]!.fontSize - big[i]!.fontSize) < 0.5 && !isLessonTitle(p.lines[j + 1]!.text) && !isUnitTitle(p.lines[j + 1]!.text)) {
        title += " " + p.lines[j + 1]!.text;
        j++;
        i++;
      }
      if (isLessonTitle(title)) markers.push({ kind: "lesson", title: title.trim(), page: p.pageNumber, order: order++ });
      else if (isUnitTitle(title)) markers.push({ kind: "unit", title: title.trim(), page: p.pageNumber, order: order++ });
    }
  }
  return finalize(markers, lastPage, "heading");
}

/**
 * Lesson boundary detection. Priority: PDF outline → heading heuristics → one whole-document lesson.
 * Learning objectives are never invented here; they stay empty until a teacher supplies/verifies them.
 */
export function detectLessons(opts: { outline: OutlineEntry[]; pages: ExtractedPage[]; fallbackTitle: string }): LessonDraft[] {
  const lastPage = opts.pages.length ? Math.max(...opts.pages.map((p) => p.pageNumber)) : 1;
  const a = fromOutline(opts.outline, lastPage);
  if (a.length) return a;
  const b = fromHeadings(opts.pages, lastPage);
  if (b.length) return b;
  return [{ ordinal: 0, title: opts.fallbackTitle, unitTitle: null, startPage: 1, endPage: lastPage, method: "whole_document" }];
}
