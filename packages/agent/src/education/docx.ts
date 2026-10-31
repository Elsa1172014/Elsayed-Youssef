import { readFileSync, writeFileSync } from "node:fs";
import JSZip from "jszip";

/**
 * Template-preserving DOCX filling. Only <w:t> text and (for empty value cells) one run are touched;
 * styles, numbering, headers, tables, page setup and every other package part stay byte-identical.
 */

const xmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlUnescape = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const ARABIC = /[؀-ۿ]/;
const norm = (s: string): string => s.replace(/[:：\s‏‎]+/g, " ").trim().toLowerCase();

const PARA_RE = /<w:p[ >][\s\S]*?<\/w:p>/g;
const CELL_RE = /<w:tc>[\s\S]*?<\/w:tc>/g;
const ROW_RE = /<w:tr[ >][\s\S]*?<\/w:tr>/g;
const T_RE = /(<w:t(?: [^>]*)?>)([\s\S]*?)(<\/w:t>)/g;

function paragraphText(p: string): string {
  let out = "";
  for (const m of p.matchAll(T_RE)) out += xmlUnescape(m[2] ?? "");
  return out;
}
const cellText = (c: string): string => [...c.matchAll(PARA_RE)].map((m) => paragraphText(m[0])).join("\n").trim();

export interface InspectResult {
  placeholders: string[];
  /** Label cells whose neighbouring cell is empty: these are the fillable table fields. */
  emptyFields: string[];
  tables: number;
  paragraphs: number;
}

export async function inspectDocx(path: string): Promise<InspectResult> {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const xml = await zip.file("word/document.xml")!.async("string");
  const placeholders = new Set<string>();
  for (const p of xml.match(PARA_RE) ?? []) for (const m of paragraphText(p).matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) placeholders.add(m[1]!);
  const emptyFields: string[] = [];
  for (const row of xml.match(ROW_RE) ?? []) {
    const cells = row.match(CELL_RE) ?? [];
    for (let i = 0; i < cells.length - 1; i++) {
      const label = cellText(cells[i]!);
      if (label && !label.includes("{{") && cellText(cells[i + 1]!) === "") emptyFields.push(label.replace(/[:：]\s*$/, ""));
    }
  }
  return { placeholders: [...placeholders], emptyFields, tables: (xml.match(/<w:tbl>/g) ?? []).length, paragraphs: (xml.match(PARA_RE) ?? []).length };
}

/** Replace {{key}} even when Word split it across several runs; formatting of surrounding runs is kept. */
function fillPlaceholdersInParagraph(p: string, values: Map<string, string>, used: Set<string>): string {
  const runs = [...p.matchAll(T_RE)];
  if (runs.length === 0) return p;
  const texts = runs.map((m) => xmlUnescape(m[2] ?? ""));
  let full = texts.join("");
  if (!full.includes("{{")) return p;

  let changed = false;
  full = full.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (all, key: string) => {
    const v = values.get(norm(key));
    if (v === undefined) return all;
    used.add(norm(key));
    changed = true;
    return v;
  });
  if (!changed) return p;

  // Locate which runs the original placeholders spanned and rebuild text per run.
  const original = texts.join("");
  const newTexts = [...texts];
  let cursor = 0;
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  const pieces: { start: number; end: number; repl: string }[] = [];
  for (const m of original.matchAll(re)) {
    const v = values.get(norm(m[1]!));
    if (v !== undefined) pieces.push({ start: m.index!, end: m.index! + m[0].length, repl: v });
  }
  // map char offsets to runs
  const bounds: number[] = [];
  for (const t of texts) { bounds.push(cursor); cursor += t.length; }
  const runAt = (off: number): number => { let r = 0; for (let i = 0; i < bounds.length; i++) if (bounds[i]! <= off) r = i; return r; };
  for (let k = pieces.length - 1; k >= 0; k--) {
    const { start, end, repl } = pieces[k]!;
    const rs = runAt(start);
    const re_ = runAt(Math.max(start, end - 1));
    const before = newTexts[rs]!.slice(0, start - bounds[rs]!);
    const after = newTexts[re_]!.slice(end - bounds[re_]!);
    for (let r = rs; r <= re_; r++) newTexts[r] = "";
    newTexts[rs] = before + repl;
    newTexts[re_] = re_ === rs ? newTexts[rs]! + after : after;
  }
  let i = 0;
  return p.replace(T_RE, (_m, open: string, _body: string, close: string) => {
    const t = xmlEscape(newTexts[i++] ?? "");
    const o = open.includes("xml:space") ? open : open.replace("<w:t", '<w:t xml:space="preserve"');
    return `${o}${t}${close}`;
  });
}

function writeIntoEmptyCell(cell: string, value: string): string {
  const lines = value.split(/\r?\n/);
  const rpr = ARABIC.test(value) ? "<w:rPr><w:rtl/></w:rPr>" : "";
  const runXml = `<w:r>${rpr}${lines.map((l, i) => `${i ? "<w:br/>" : ""}<w:t xml:space="preserve">${xmlEscape(l)}</w:t>`).join("")}</w:r>`;
  // reuse the cell's existing first paragraph (keeps its paragraph style, alignment, RTL)
  const para = cell.match(/<w:p[ >][\s\S]*?<\/w:p>/)?.[0];
  if (!para) return cell.replace("</w:tc>", `<w:p>${runXml}</w:p></w:tc>`);
  let newPara: string;
  if (/<w:r[ >]/.test(para)) {
    // keep an existing (empty) run's properties
    newPara = para.replace(/<w:r( [^>]*)?>([\s\S]*?)<\/w:r>/, (_m, attrs: string | undefined, inner: string) => {
      const props = inner.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] ?? rpr;
      return `<w:r${attrs ?? ""}>${props}${lines.map((l, i) => `${i ? "<w:br/>" : ""}<w:t xml:space="preserve">${xmlEscape(l)}</w:t>`).join("")}</w:r>`;
    });
  } else if (para.endsWith("</w:p>") && !para.endsWith("/>")) {
    newPara = para.replace(/<\/w:p>$/, `${runXml}</w:p>`);
  } else newPara = para;
  return cell.replace(para, newPara);
}

export interface FillResult {
  ok: boolean;
  outputPath: string;
  filled: string[];
  /** Template fields that received no value: reported, never invented. */
  unfilled: string[];
  unusedKeys: string[];
  checks: { tablesPreserved: boolean; untouchedPartsIdentical: boolean; allValuesPresent: boolean };
}

export async function fillDocx(templatePath: string, outputPath: string, values: Record<string, string>): Promise<FillResult> {
  const map = new Map(Object.entries(values).map(([k, v]) => [norm(k), v]));
  const used = new Set<string>();
  const srcBuf = readFileSync(templatePath);
  const zip = await JSZip.loadAsync(srcBuf);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("not a valid .docx (word/document.xml missing)");
  const xml = await docFile.async("string");
  const before = await inspectDocx(templatePath);

  // 1) {{placeholders}} (paragraph by paragraph, including inside table cells)
  let out = xml.replace(PARA_RE, (p) => fillPlaceholdersInParagraph(p, map, used));

  // 2) label cell -> empty neighbour cell
  const filledLabels: string[] = [];
  out = out.replace(ROW_RE, (row) => {
    const cells = row.match(CELL_RE) ?? [];
    let updated = row;
    for (let i = 0; i < cells.length - 1; i++) {
      const label = cellText(cells[i]!);
      if (!label || label.includes("{{")) continue;
      const v = map.get(norm(label));
      if (v === undefined || cellText(cells[i + 1]!) !== "") continue;
      updated = updated.replace(cells[i + 1]!, writeIntoEmptyCell(cells[i + 1]!, v));
      used.add(norm(label));
      filledLabels.push(label.replace(/[:：]\s*$/, ""));
    }
    return updated;
  });

  zip.file("word/document.xml", out);
  const outBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  writeFileSync(outputPath, outBuf);

  // Verification: reopen from disk.
  const re = await JSZip.loadAsync(readFileSync(outputPath));
  const reXml = await re.file("word/document.xml")!.async("string");
  const after = await inspectDocx(outputPath);
  let identical = true;
  for (const name of Object.keys(zip.files)) {
    if (name === "word/document.xml" || zip.files[name]!.dir) continue;
    const a = await (await JSZip.loadAsync(srcBuf)).file(name)!.async("uint8array");
    const b = await re.file(name)?.async("uint8array");
    if (!b || a.length !== b.length || a.some((x, i) => x !== b[i])) identical = false;
  }
  const plain = [...(reXml.match(PARA_RE) ?? [])].map(paragraphText).join("\n");
  const filledKeys = [...used];
  const allValuesPresent = filledKeys.every((k) => {
    const v = map.get(k)!;
    return v.split(/\r?\n/).every((line) => plain.includes(line));
  });
  const unfilled = [...before.placeholders.filter((k) => !map.has(norm(k))), ...before.emptyFields.filter((f) => !map.has(norm(f)))];
  const tablesPreserved = before.tables === after.tables;
  const ok = tablesPreserved && identical && allValuesPresent && filledKeys.length > 0;
  return {
    ok,
    outputPath,
    filled: [...before.placeholders.filter((k) => used.has(norm(k))), ...filledLabels],
    unfilled,
    unusedKeys: [...map.keys()].filter((k) => !used.has(k)),
    checks: { tablesPreserved, untouchedPartsIdentical: identical, allValuesPresent },
  };
}
