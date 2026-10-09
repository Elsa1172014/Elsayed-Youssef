import { arabicRatio, stripControlChars } from "@/lib/arabic/normalize";

/** Minimal, library-independent description of a positioned PDF text run (a glyph or a word). */
export interface RawTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextLine {
  text: string;
  y: number;
  x0: number;
  x1: number;
  fontSize: number;
}

const COMBINING_MARKS = /^\s*[ً-ٰٕ](?:\s*[ً-ٰٕ])*\s*$/;
const LTR_STRONG = /[A-Za-z0-9]/;

function sortRtl(items: RawTextItem[]): RawTextItem[] {
  const marks = items.filter((i) => COMBINING_MARKS.test(i.str));
  const base = items.filter((i) => !COMBINING_MARKS.test(i.str));
  // Visual left→right glyph order is the reverse of logical order for RTL text.
  const sorted = base.map((it, idx) => ({ it, idx })).sort((a, b) => b.it.x - a.it.x || a.idx - b.idx).map((o) => o.it);

  // Re-reverse runs of Latin/digit items so "123" stays "123" inside an RTL line.
  const out: RawTextItem[] = [];
  let run: RawTextItem[] = [];
  const flush = () => {
    const tail: RawTextItem[] = [];
    while (run.length && run[run.length - 1]!.str.trim() === "") tail.unshift(run.pop()!);
    out.push(...run.reverse(), ...tail);
    run = [];
  };
  for (const it of sorted) {
    if (LTR_STRONG.test(it.str)) run.push(it);
    else if (run.length && it.str.trim() === "") run.push(it); // spaces inside a run
    else {
      flush();
      out.push(it);
    }
  }
  flush();

  // Attach each diacritic after the base glyph it sits on: prefer the glyph whose horizontal span contains
  // the mark's centre; otherwise the nearest centre. Several marks on one base keep their input order.
  const placed = new Map<number, RawTextItem[]>();
  for (const m of marks) {
    const cx = m.x + m.width / 2;
    let best = -1;
    let bestScore = Infinity;
    out.forEach((b, i) => {
      if (b.str.trim() === "") return;
      const inside = cx >= b.x - 0.5 && cx <= b.x + b.width + 0.5;
      const score = (inside ? 0 : 1000) + Math.abs(b.x + b.width / 2 - cx);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best >= 0) placed.set(best, [...(placed.get(best) ?? []), m]);
    else placed.set(-1, [...(placed.get(-1) ?? []), m]);
  }
  const withMarks: RawTextItem[] = [];
  out.forEach((b, i) => {
    withMarks.push(b);
    const ms = placed.get(i);
    if (ms) withMarks.push(...ms.sort((a, c) => a.x - c.x));
  });
  return withMarks;
}

function joinItems(ordered: RawTextItem[], rtl: boolean): string {
  let s = "";
  let prev: RawTextItem | undefined;
  // When the PDF emits explicit space glyphs/trailing spaces, trust them; geometry-based spacing is only
  // a fallback (it misfires around detached diacritics).
  const hasExplicitSpaces = ordered.some((i) => /\s/.test(i.str) && !COMBINING_MARKS.test(i.str));
  for (const it of ordered) {
    if (!hasExplicitSpaces && prev && prev.str.trim() !== "" && it.str.trim() !== "" && !COMBINING_MARKS.test(it.str)) {
      const gap = rtl ? prev.x - (it.x + it.width) : it.x - (prev.x + prev.width);
      if (gap > Math.max(it.height, prev.height) * 0.3) s += " ";
    }
    s += COMBINING_MARKS.test(it.str) ? it.str.replace(/\s+/g, "") : it.str;
    if (!COMBINING_MARKS.test(it.str) && !(it.str.trim() === "" && prev)) prev = it;
  }
  return s;
}

/** Cluster positioned text runs into visual lines and put each line in logical reading order. */
export function assembleLines(items: RawTextItem[]): TextLine[] {
  const live = items
    .map((i) => ({ ...i, str: stripControlChars(i.str) }))
    .filter((i) => i.str !== "" && Number.isFinite(i.x) && Number.isFinite(i.y));
  // Diacritic runs sit above/below the baseline and must not form their own "line".
  const markItems = live.filter((i) => COMBINING_MARKS.test(i.str));
  const byY = live.filter((i) => !COMBINING_MARKS.test(i.str)).sort((a, b) => b.y - a.y);
  const groups: RawTextItem[][] = [];
  let anchorY = Number.NaN;
  let anchorH = 0;
  for (const it of byY) {
    const tol = Math.max(2, 0.45 * Math.max(anchorH, it.height));
    if (groups.length && Math.abs(it.y - anchorY) <= tol) {
      groups[groups.length - 1]!.push(it);
      anchorH = Math.max(anchorH, it.height);
    } else {
      groups.push([it]);
      anchorY = it.y;
      anchorH = it.height;
    }
  }
  for (const m of markItems) {
    let best: RawTextItem[] | undefined;
    let bestD = Infinity;
    for (const g of groups) {
      const h = Math.max(...g.map((i) => i.height));
      const d = Math.abs(g[0]!.y - m.y);
      const withinX = g.some((i) => m.x >= i.x - h * 0.3 && m.x <= i.x + i.width + h * 0.3);
      if (withinX && d <= h * 1.5 && d < bestD) {
        best = g;
        bestD = d;
      }
    }
    best?.push(m);
  }

  const lines: TextLine[] = [];
  for (const g of groups) {
    const rawText = g.map((i) => i.str).join("");
    const rtl = arabicRatio(rawText) >= 0.5;
    const ordered = rtl ? sortRtl(g) : [...g].sort((a, b) => a.x - b.x);
    const text = joinItems(ordered, rtl).normalize("NFKC").replace(/[ \t]+/g, " ").trim();
    if (!/[\p{L}\p{N}]/u.test(text.replace(/[\u064B-\u0655\u0670]/g, ""))) continue; // marks/punctuation only
    const base = g.filter((i) => !COMBINING_MARKS.test(i.str));
    lines.push({
      text,
      y: base[0]!.y,
      x0: Math.min(...base.map((i) => i.x)),
      x1: Math.max(...base.map((i) => i.x + i.width)),
      fontSize: Math.max(...base.map((i) => i.height)),
    });
  }
  return lines;
}

/** Lines → text. Blank line where the vertical gap suggests a paragraph break. */
export function linesToText(lines: TextLine[]): string {
  let out = "";
  let prev: TextLine | undefined;
  for (const l of lines) {
    if (prev) {
      const gap = prev.y - l.y;
      out += gap > Math.max(prev.fontSize, l.fontSize) * 2.1 ? "\n\n" : "\n";
    }
    out += l.text;
    prev = l;
  }
  return out;
}

export function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
