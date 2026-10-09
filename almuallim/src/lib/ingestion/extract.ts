import { getDocumentProxy } from "unpdf";
import { looksVisuallyReversed, normalizeArabic, normalizeDigits, reverseVisualLines } from "@/lib/arabic/normalize";
import { assembleLines, linesToText, median, type RawTextItem, type TextLine } from "./layout";

export type PdfDoc = Awaited<ReturnType<typeof getDocumentProxy>>;

export interface ExtractedPage {
  pageNumber: number;           // physical, 1-based
  lines: TextLine[];
  text: string;                 // display text (NFKC-folded, logical order)
  textNormalized: string;       // matching text
  hasText: boolean;             // false → likely scanned; needs OCR
  printedLabel: string | null;  // page number printed on the page, if detected
  medianFont: number;
  reversedFixed: boolean;       // visual-order repair was applied
}

export interface OutlineEntry {
  title: string;
  pageNumber: number | null;
  depth: number;
}

export async function openPdf(bytes: Uint8Array): Promise<PdfDoc> {
  // unpdf bundles a serverless-safe pdf.js build; copy the buffer because pdf.js transfers it.
  return getDocumentProxy(new Uint8Array(bytes));
}

const MIN_CHARS_FOR_TEXT = 20;

/** Page number printed in the header/footer band: a lone short numeric line near top or bottom. */
export function detectPrintedLabel(lines: TextLine[]): string | null {
  if (!lines.length) return null;
  const candidates = [lines[lines.length - 1]!, lines[0]!];
  for (const l of candidates) {
    const t = normalizeDigits(l.text).replace(/[^\d]/g, "");
    const stripped = l.text.replace(/[\s\-–—.()]/g, "");
    if (t.length >= 1 && t.length <= 4 && normalizeDigits(stripped) === t) return t;
  }
  return null;
}

export async function extractPage(doc: PdfDoc, pageNumber: number): Promise<ExtractedPage> {
  const page = await doc.getPage(pageNumber);
  const tc = await page.getTextContent();
  const items: RawTextItem[] = [];
  for (const it of tc.items) {
    if (!("str" in it)) continue;
    items.push({ str: it.str, x: it.transform[4]!, y: it.transform[5]!, width: it.width, height: it.height || Math.abs(it.transform[3]!) });
  }
  let lines = assembleLines(items);
  let text = linesToText(lines);
  let reversedFixed = false;
  if (looksVisuallyReversed(text)) {
    text = reverseVisualLines(text);
    lines = lines.map((l) => ({ ...l, text: [...l.text].reverse().join("") }));
    reversedFixed = true;
  }
  const printedLabel = detectPrintedLabel(lines);
  const body = printedLabel && lines.length && normalizeDigits(lines[lines.length - 1]!.text).replace(/\D/g, "") === printedLabel
    ? lines.slice(0, -1)
    : lines;
  const bodyText = body === lines ? text : linesToText(body);
  return {
    pageNumber,
    lines,
    text: bodyText,
    textNormalized: normalizeArabic(bodyText),
    hasText: bodyText.replace(/\s/g, "").length >= MIN_CHARS_FOR_TEXT,
    printedLabel,
    medianFont: median(lines.map((l) => l.fontSize)),
    reversedFixed,
  };
}

/** Resolve the PDF outline (bookmarks) to physical page numbers. Returns [] when the PDF has none. */
export async function extractOutline(doc: PdfDoc): Promise<OutlineEntry[]> {
  const root = await doc.getOutline().catch(() => null);
  if (!root) return [];
  const out: OutlineEntry[] = [];
  const walk = async (nodes: NonNullable<typeof root>, depth: number) => {
    for (const n of nodes) {
      let pageNumber: number | null = null;
      try {
        const dest = typeof n.dest === "string" ? await doc.getDestination(n.dest) : n.dest;
        const ref = dest?.[0];
        if (ref && typeof ref === "object") pageNumber = (await doc.getPageIndex(ref as never)) + 1;
        else if (typeof ref === "number") pageNumber = ref + 1;
      } catch {
        pageNumber = null;
      }
      out.push({ title: n.title.normalize("NFKC").replace(/\s+/g, " ").trim(), pageNumber, depth });
      if (n.items?.length) await walk(n.items as never, depth + 1);
    }
  };
  await walk(root, 0);
  return out;
}
