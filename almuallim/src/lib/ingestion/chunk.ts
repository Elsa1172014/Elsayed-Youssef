import { estimateTokens, normalizeArabic } from "@/lib/arabic/normalize";
import { sha256Hex } from "@/lib/hash";
import type { ExtractedPage } from "./extract";
import type { LessonDraft } from "./lessons";

export interface ChunkDraft {
  ordinal: number;
  lessonOrdinal: number | null;
  pageStart: number;
  pageEnd: number;
  content: string;            // verbatim textbook text (what gets quoted)
  contentNormalized: string;
  tokenEstimate: number;
  contentHash: string;
  embedText: string;          // lesson title + content: improves recall for short chunks
}

/** Text sent to the embedding model for a chunk: lesson title gives short chunks topical context. */
export const buildEmbedText = (lessonTitle: string | null | undefined, content: string): string =>
  lessonTitle ? `${lessonTitle}\n${content}` : content;

export interface ChunkOptions {
  targetTokens: number;
  maxTokens: number;
  minTokens: number;
}
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { targetTokens: 380, maxTokens: 600, minTokens: 90 };

interface Unit {
  text: string;
  page: number;
}

/** Page text → paragraph-ish units; single newlines are soft wraps, blank lines are breaks. */
function toUnits(page: ExtractedPage): Unit[] {
  return page.text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0)
    .map((text) => ({ text, page: page.pageNumber }));
}

/** Split an over-long unit on sentence terminators (Arabic and Latin) without losing characters. */
function splitLong(u: Unit, maxChars: number): Unit[] {
  if (u.text.length <= maxChars) return [u];
  const sentences = u.text.split(/(?<=[.؟?!؛:])\s+/u);
  const out: Unit[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + " " + s).length > maxChars) {
      out.push({ text: cur, page: u.page });
      cur = s;
    } else cur = cur ? cur + " " + s : s;
  }
  if (cur) out.push({ text: cur, page: u.page });
  // A single sentence longer than the cap: hard split on whitespace.
  return out.flatMap((o) => {
    if (o.text.length <= maxChars * 1.5) return [o];
    const words = o.text.split(" ");
    const parts: Unit[] = [];
    let buf = "";
    for (const w of words) {
      if (buf && (buf + " " + w).length > maxChars) {
        parts.push({ text: buf, page: o.page });
        buf = w;
      } else buf = buf ? buf + " " + w : w;
    }
    if (buf) parts.push({ text: buf, page: o.page });
    return parts;
  });
}

export function lessonOrdinalForPage(lessons: LessonDraft[], page: number): number | null {
  let best: LessonDraft | undefined;
  for (const l of lessons) {
    if (l.startPage <= page && page <= l.endPage && (!best || l.startPage >= best.startPage)) best = l;
  }
  return best ? best.ordinal : null;
}

/**
 * Page-aware chunking. Chunks never cross a lesson boundary, keep exact page ranges, and are
 * deterministic: the same input always yields the same ordinals and hashes (idempotent re-runs).
 */
export function chunkBook(pages: ExtractedPage[], lessons: LessonDraft[], opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): ChunkDraft[] {
  const maxChars = Math.floor(opts.maxTokens * 2.2);
  const targetChars = Math.floor(opts.targetTokens * 2.2);
  const minChars = Math.floor(opts.minTokens * 2.2);
  const titleOf = new Map(lessons.map((l) => [l.ordinal, l.title]));

  // Group units by lesson, preserving page order.
  const groups: { lesson: number | null; units: Unit[] }[] = [];
  for (const p of [...pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
    if (!p.hasText) continue;
    const lo = lessonOrdinalForPage(lessons, p.pageNumber);
    let g = groups[groups.length - 1];
    if (!g || g.lesson !== lo) {
      g = { lesson: lo, units: [] };
      groups.push(g);
    }
    g.units.push(...toUnits(p).flatMap((u) => splitLong(u, maxChars)));
  }

  // Pack units into pending chunks per lesson group, then convert to drafts.
  const pending: { lesson: number | null; units: Unit[]; chars: number }[] = [];
  for (const g of groups) {
    let cur: { lesson: number | null; units: Unit[]; chars: number } | null = null;
    const first = pending.length;
    for (const u of g.units) {
      if (cur && cur.chars + u.text.length > targetChars && cur.chars >= minChars) {
        pending.push(cur);
        cur = null;
      }
      cur ??= { lesson: g.lesson, units: [], chars: 0 };
      cur.units.push(u);
      cur.chars += u.text.length + 1;
    }
    if (cur) {
      const prev = pending.length > first ? pending[pending.length - 1] : undefined;
      // Merge a short tail into the previous chunk of the same lesson rather than emit a stub.
      if (cur.chars < minChars && prev) {
        prev.units.push(...cur.units);
        prev.chars += cur.chars;
      } else pending.push(cur);
    }
  }

  const drafts: ChunkDraft[] = [];
  for (const pc of pending) {
    const content = pc.units.map((b) => b.text).join("\n");
    const contentNormalized = normalizeArabic(content);
    if (!contentNormalized) continue;
    const title = pc.lesson != null ? titleOf.get(pc.lesson) : undefined;
    drafts.push({
      ordinal: drafts.length,
      lessonOrdinal: pc.lesson,
      pageStart: pc.units[0]!.page,
      pageEnd: pc.units[pc.units.length - 1]!.page,
      content,
      contentNormalized,
      tokenEstimate: estimateTokens(content),
      contentHash: sha256Hex(`${pc.lesson ?? "-"}|${contentNormalized}`),
      embedText: buildEmbedText(title, content),
    });
  }
  return drafts;
}
