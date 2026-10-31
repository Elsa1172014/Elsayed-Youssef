import ExcelJS from "exceljs";
import { readFileSync, writeFileSync } from "node:fs";

export type Cell = string | number | null;
export interface Table { headers: string[]; rows: Cell[][]; source: string; sheet?: string }

/** RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF, BOM). */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], f = "", q = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(f); out.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); out.push(row); }
  return out.filter((r) => r.some((x) => x.trim() !== ""));
}

const toCell = (v: unknown): Cell => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object") {
    const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[] };
    if (o.result !== undefined) return toCell(o.result);
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.text !== undefined) return String(o.text);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v);
  }
  const s = String(v).trim();
  return s === "" ? null : s;
};

export async function readTable(path: string, sheet?: string): Promise<Table> {
  if (/\.csv$/i.test(path)) {
    const [h, ...rows] = parseCsv(readFileSync(path, "utf8"));
    if (!h) throw new Error("empty CSV");
    return { headers: h.map((x) => x.trim()), rows: rows.map((r) => h.map((_, i) => toCell(r[i]))), source: path };
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = sheet ? wb.getWorksheet(sheet) : wb.worksheets[0];
  if (!ws) throw new Error(`sheet not found: ${sheet ?? "(first)"}; available: ${wb.worksheets.map((w) => w.name).join(", ")}`);
  const all: Cell[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals: Cell[] = [];
    for (let c = 1; c <= ws.columnCount; c++) vals.push(toCell(row.getCell(c).value));
    all.push(vals);
  });
  const [h, ...rows] = all;
  if (!h) throw new Error("empty sheet");
  return { headers: h.map((x) => String(x ?? "").trim()), rows, source: path, sheet: ws.name };
}

export interface AnalyzeOptions {
  studentCol: string;
  currentCol: string;
  classCol?: string;
  targetCol?: string;
  previousCol?: string;
  /** Points of progress considered "expected" between previous and current. Not guessed if omitted. */
  expectedProgress?: number;
  /** |current - target| <= tolerance counts as "at expected". Default 0. */
  tolerance?: number;
  anonymize?: boolean;
}

export interface Calc { name: string; formula: string; n: number; result: number | null }
export interface StudentRow {
  rowNumber: number; id: string; cls: string; current: number; target: number | null; previous: number | null;
  attainment: "below" | "expected" | "above" | "no-target"; delta: number | null;
  progress: "below" | "expected" | "above" | "not-classified" | "no-previous";
}
export interface Analysis {
  quality: {
    rows: number; usedRows: number;
    excluded: { rowNumber: number; reason: string }[];
    duplicateIds: { id: string; rowNumbers: number[] }[];
    missingByColumn: Record<string, number>;
  };
  students: StudentRow[];
  classes: { cls: string; n: number; meanCurrent: number; meanTarget: number | null; below: number; expected: number; above: number; evidence: string }[];
  overall: { n: number; meanCurrent: number | null; below: number; expected: number; above: number; noTarget: number; belowShare: number | null };
  intervention: { id: string; cls: string; reason: string }[];
  calculations: Calc[];
  notes: string[];
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (n: number | null, d = 2): number | null => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);
const num = (c: Cell | undefined): number | null => {
  if (typeof c === "number") return Number.isFinite(c) ? c : null;
  if (typeof c === "string") { const n = Number(c.replace(/%$/, "")); return c.trim() !== "" && Number.isFinite(n) ? n : null; }
  return null;
};

export function analyze(t: Table, o: AnalyzeOptions): Analysis {
  const idx = (name: string | undefined): number => {
    if (!name) return -1;
    const i = t.headers.indexOf(name);
    if (i < 0) throw new Error(`column '${name}' not found; columns: ${t.headers.join(" | ")}`);
    return i;
  };
  const iS = idx(o.studentCol), iC = idx(o.currentCol);
  const iK = idx(o.classCol), iT = idx(o.targetCol), iP = idx(o.previousCol);
  const tol = o.tolerance ?? 0;

  const missingByColumn: Record<string, number> = {};
  t.headers.forEach((h, i) => { missingByColumn[h] = t.rows.filter((r) => r[i] === null || r[i] === undefined).length; });

  const excluded: { rowNumber: number; reason: string }[] = [];
  const students: StudentRow[] = [];
  const ids = new Map<string, number[]>();
  t.rows.forEach((r, k) => {
    const rowNumber = k + 2; // spreadsheet row (header is row 1)
    const id = r[iS] === null || r[iS] === undefined ? "" : String(r[iS]);
    if (id === "") return void excluded.push({ rowNumber, reason: "missing student identifier" });
    ids.set(id, [...(ids.get(id) ?? []), rowNumber]);
    const cur = num(r[iC]);
    if (cur === null) return void excluded.push({ rowNumber, reason: r[iC] === null ? "missing current value" : `non-numeric current value '${String(r[iC])}'` });
    const tg = iT >= 0 ? num(r[iT]) : null;
    const pv = iP >= 0 ? num(r[iP]) : null;
    const attainment: StudentRow["attainment"] = tg === null ? "no-target" : cur < tg - tol ? "below" : cur > tg + tol ? "above" : "expected";
    const delta = pv === null ? null : cur - pv;
    let progress: StudentRow["progress"] = pv === null ? "no-previous" : "not-classified";
    if (delta !== null && o.expectedProgress !== undefined) progress = delta < o.expectedProgress ? "below" : delta > o.expectedProgress ? "above" : "expected";
    students.push({ rowNumber, id, cls: iK >= 0 ? String(r[iK] ?? "(no class)") : "(all)", current: cur, target: tg, previous: pv, attainment, delta, progress });
  });

  // Duplicates: same id on several rows → keep first, exclude the rest (never silently merge or average).
  const duplicateIds = [...ids].filter(([, rn]) => rn.length > 1).map(([id, rowNumbers]) => ({ id, rowNumbers }));
  const seen = new Set<string>();
  const dedup = students.filter((s) => {
    if (seen.has(s.id)) { excluded.push({ rowNumber: s.rowNumber, reason: `duplicate student id '${s.id}' (first occurrence kept)` }); return false; }
    seen.add(s.id);
    return true;
  });

  const calculations: Calc[] = [];
  const calc = (name: string, formula: string, xs: number[]): number | null => {
    const r = round(mean(xs));
    calculations.push({ name, formula, n: xs.length, result: r });
    return mean(xs);
  };
  const classNames = [...new Set(dedup.map((s) => s.cls))].sort();
  const classes = classNames.map((cls) => {
    const g = dedup.filter((s) => s.cls === cls);
    const withT = g.filter((s) => s.target !== null);
    const mc = calc(`mean current — ${cls}`, `AVERAGE(${o.currentCol}) where ${o.classCol ?? "all"}='${cls}'`, g.map((s) => s.current))!;
    const mt = withT.length ? calc(`mean target — ${cls}`, `AVERAGE(${o.targetCol}) where class='${cls}' and target present`, withT.map((s) => s.target!)) : null;
    const c = (k: StudentRow["attainment"]): number => g.filter((s) => s.attainment === k).length;
    const evid = g.length < 10 ? `low evidence (n=${g.length} < 10)` : withT.length < g.length * 0.8 ? `incomplete targets (${withT.length}/${g.length})` : "adequate";
    return { cls, n: g.length, meanCurrent: round(mc)!, meanTarget: round(mt), below: c("below"), expected: c("expected"), above: c("above"), evidence: evid };
  });
  const withT = dedup.filter((s) => s.attainment !== "no-target");
  const overall = {
    n: dedup.length,
    meanCurrent: round(calc("mean current — all", `AVERAGE(${o.currentCol})`, dedup.map((s) => s.current))),
    below: dedup.filter((s) => s.attainment === "below").length,
    expected: dedup.filter((s) => s.attainment === "expected").length,
    above: dedup.filter((s) => s.attainment === "above").length,
    noTarget: dedup.filter((s) => s.attainment === "no-target").length,
    belowShare: withT.length ? round((dedup.filter((s) => s.attainment === "below").length / withT.length) * 100, 1) : null,
  };
  const deltas = dedup.filter((s) => s.delta !== null).map((s) => s.delta!);
  if (deltas.length) calc("mean progress (current − previous)", `AVERAGE(${o.currentCol} − ${o.previousCol})`, deltas);

  const intervention = dedup
    .filter((s) => s.attainment === "below" || (s.delta !== null && s.delta < 0))
    .map((s) => ({
      id: s.id, cls: s.cls,
      reason: [s.attainment === "below" ? `below target (${s.current} < ${s.target})` : "", s.delta !== null && s.delta < 0 ? `regressed by ${-s.delta}` : ""].filter(Boolean).join("; "),
    }));

  const notes: string[] = [];
  if (!o.targetCol) notes.push("No target column supplied: attainment bands (below/expected/above) were NOT computed.");
  if (o.previousCol && o.expectedProgress === undefined) notes.push("Progress deltas are reported, but students are NOT classified as below/expected/above progress because no expectedProgress threshold was provided.");
  if (!o.previousCol) notes.push("No previous-assessment column: progress cannot be measured; only attainment is reported.");
  if (excluded.length) notes.push(`${excluded.length} row(s) excluded from calculations (see quality.excluded). No values were imputed.`);
  return { quality: { rows: t.rows.length, usedRows: dedup.length, excluded, duplicateIds, missingByColumn }, students: dedup, classes, overall, intervention, calculations, notes };
}

/** Independent recomputation used as a self-check before any report is declared valid. */
export function selfCheck(t: Table, o: AnalyzeOptions, a: Analysis): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const cur = a.students.map((s) => s.current);
  const m = cur.reduce((x, y) => x + y, 0) / (cur.length || 1);
  if (a.overall.meanCurrent !== null && Math.abs(m - a.overall.meanCurrent) > 0.01) problems.push("overall mean mismatch");
  if (a.overall.below + a.overall.expected + a.overall.above + a.overall.noTarget !== a.overall.n) problems.push("band counts do not add up to n");
  if (a.quality.usedRows + a.quality.excluded.length !== a.quality.rows) problems.push("used + excluded rows != total rows");
  if (a.classes.reduce((s, c) => s + c.n, 0) !== a.overall.n) problems.push("class sizes do not add up");
  void t; void o;
  return { ok: problems.length === 0, problems };
}

export function anonymizeIds(a: Analysis): Analysis {
  const map = new Map<string, string>();
  const alias = (id: string): string => map.get(id) ?? (map.set(id, `S${String(map.size + 1).padStart(3, "0")}`), map.get(id)!);
  return {
    ...a,
    students: a.students.map((s) => ({ ...s, id: alias(s.id) })),
    intervention: a.intervention.map((s) => ({ ...s, id: alias(s.id) })),
    quality: { ...a.quality, duplicateIds: a.quality.duplicateIds.map((d) => ({ ...d, id: alias(d.id) })) },
  };
}

export function toMarkdown(a: Analysis, o: AnalyzeOptions, source: string): string {
  const L: string[] = [];
  L.push(`# Educational data report`, `Source: \`${source}\` (read-only; the original file was not modified)`, "");
  L.push(`## Data quality`, `- Rows: ${a.quality.rows}; used: ${a.quality.usedRows}; excluded: ${a.quality.excluded.length}`);
  for (const e of a.quality.excluded.slice(0, 20)) L.push(`  - row ${e.rowNumber}: ${e.reason}`);
  if (a.quality.duplicateIds.length) L.push(`- Duplicate IDs: ${a.quality.duplicateIds.map((d) => `${d.id} (rows ${d.rowNumbers.join(",")})`).join("; ")}`);
  L.push(`- Missing values per column: ${Object.entries(a.quality.missingByColumn).map(([k, v]) => `${k}=${v}`).join(", ")}`, "");
  L.push(`## Attainment (vs target, tolerance ±${o.tolerance ?? 0})`, `| Class | n | Mean current | Mean target | Below | Expected | Above | Evidence |`, `|---|---|---|---|---|---|---|---|`);
  for (const c of a.classes) L.push(`| ${c.cls} | ${c.n} | ${c.meanCurrent} | ${c.meanTarget ?? "—"} | ${c.below} | ${c.expected} | ${c.above} | ${c.evidence} |`);
  L.push("", `Overall: n=${a.overall.n}, below ${a.overall.below}, expected ${a.overall.expected}, above ${a.overall.above}, no target ${a.overall.noTarget}${a.overall.belowShare !== null ? ` (${a.overall.belowShare}% below target)` : ""}`, "");
  const pd = a.calculations.find((c) => c.name.startsWith("mean progress"));
  L.push(`## Progress (change since previous assessment)`, pd ? `Mean change: ${pd.result} (n=${pd.n}).` : "Not measurable from the supplied data.", "");
  L.push(`## Areas requiring intervention (${a.intervention.length})`);
  for (const i of a.intervention.slice(0, 50)) L.push(`- ${i.id} (${i.cls}): ${i.reason}`);
  L.push("", `## Calculations (traceable)`, `| Name | Formula | n | Result |`, `|---|---|---|---|`);
  for (const c of a.calculations) L.push(`| ${c.name} | \`${c.formula}\` | ${c.n} | ${c.result} |`);
  if (a.notes.length) L.push("", `## Notes & limitations`, ...a.notes.map((n) => `- ${n}`));
  return L.join("\n");
}

export async function writeReport(a: Analysis, o: AnalyzeOptions, source: string, outBase: string): Promise<{ md: string; xlsx: string }> {
  const md = `${outBase}.md`, xlsx = `${outBase}.xlsx`;
  writeFileSync(md, toMarkdown(a, o, source), "utf8");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Students");
  ws.addRow(["Row in source", "Student", "Class", "Current", "Target", "Previous", "Attainment", "Change", "Progress"]);
  for (const s of a.students) ws.addRow([s.rowNumber, s.id, s.cls, s.current, s.target, s.previous, s.attainment, s.delta, s.progress]);
  const last = a.students.length + 1;
  const cs = wb.addWorksheet("Classes");
  cs.addRow(["Class", "n", "Mean current (formula)", "Below", "Expected", "Above", "Evidence"]);
  a.classes.forEach((c, i) => {
    const r = i + 2;
    cs.addRow([
      c.cls,
      { formula: `COUNTIF(Students!C2:C${last},A${r})`, result: c.n },
      { formula: `AVERAGEIF(Students!C2:C${last},A${r},Students!D2:D${last})`, result: c.meanCurrent },
      { formula: `COUNTIFS(Students!C2:C${last},A${r},Students!G2:G${last},"below")`, result: c.below },
      { formula: `COUNTIFS(Students!C2:C${last},A${r},Students!G2:G${last},"expected")`, result: c.expected },
      { formula: `COUNTIFS(Students!C2:C${last},A${r},Students!G2:G${last},"above")`, result: c.above },
      c.evidence,
    ]);
  });
  const q = wb.addWorksheet("Quality");
  q.addRow(["Row in source", "Reason excluded"]);
  for (const e of a.quality.excluded) q.addRow([e.rowNumber, e.reason]);
  const cc = wb.addWorksheet("Calculations");
  cc.addRow(["Name", "Formula", "n", "Result"]);
  for (const c of a.calculations) cc.addRow([c.name, c.formula, c.n, c.result]);
  for (const sheet of wb.worksheets) { sheet.getRow(1).font = { bold: true }; sheet.views = [{ rightToLeft: true }]; }
  await wb.xlsx.writeFile(xlsx);
  return { md, xlsx };
}
