import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Tool } from "../types.js";
import { analyze, anonymizeIds, readTable, selfCheck, writeReport, type AnalyzeOptions } from "./data.js";
import { fillDocx, inspectDocx } from "./docx.js";

const s = (a: Record<string, unknown>, k: string): string => {
  const v = a[k];
  if (typeof v !== "string" || !v) throw new Error(`missing string argument '${k}'`);
  return v;
};
const opt = (a: Record<string, unknown>, k: string): string | undefined => (typeof a[k] === "string" && a[k] ? (a[k] as string) : undefined);

export const inspectDocxTool: Tool = {
  name: "inspect_docx",
  group: "documents",
  description: "List the fillable fields of a Word template: {{placeholders}} and label cells with an empty neighbouring cell.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  risk: () => "low",
  describeCall: (a) => `inspect template ${String(a["path"])}`,
  paths: (a, c) => [resolve(c.cwd, s(a, "path"))],
  async run(a, c) {
    const info = await inspectDocx(resolve(c.cwd, s(a, "path")));
    return { ok: true, output: JSON.stringify(info, null, 2), data: info };
  },
};

export const fillDocxTool: Tool = {
  name: "fill_docx",
  group: "documents",
  description:
    "Fill a Word template into a NEW file, preserving layout, tables, fonts and RTL. `values` maps a {{placeholder}} name or a table label to its text. Fields without a value are reported as unfilled — never invent content for them. The result is verified by re-opening the output.",
  inputSchema: {
    type: "object",
    properties: { template: { type: "string" }, output: { type: "string" }, values: { type: "object" } },
    required: ["template", "output", "values"],
  },
  risk: (a, c) => (existsSync(resolve(c.cwd, String(a["output"] ?? ""))) ? "high" : "medium"),
  describeCall: (a) => `fill ${String(a["template"])} -> ${String(a["output"])}`,
  paths: (a, c) => [resolve(c.cwd, s(a, "template")), resolve(c.cwd, s(a, "output"))],
  async run(a, c) {
    const tpl = resolve(c.cwd, s(a, "template"));
    const out = resolve(c.cwd, s(a, "output"));
    if (tpl === out) return { ok: false, output: "output must differ from the template (the original is never overwritten)" };
    const raw = a["values"];
    if (!raw || typeof raw !== "object") return { ok: false, output: "values must be an object" };
    const values = Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    const r = await fillDocx(tpl, out, values);
    return {
      ok: r.ok,
      verified: r.ok,
      output: `${r.ok ? "filled and verified" : "FILL VERIFICATION FAILED"}: ${out}\nfilled: ${r.filled.join(", ") || "(none)"}\nUNFILLED (left blank on purpose): ${r.unfilled.join(", ") || "(none)"}\nunused keys: ${r.unusedKeys.join(", ") || "(none)"}\nchecks: ${JSON.stringify(r.checks)}`,
      data: r,
    };
  },
};

export const analyzeTableTool: Tool = {
  name: "analyze_table",
  group: "documents",
  description:
    "Analyse a CSV/XLSX of student results: data quality, attainment vs target (below/expected/above), progress vs previous, per-class summary with evidence quality, intervention list, traceable calculations. Writes <outBase>.md and <outBase>.xlsx; the source file is never modified; missing data is excluded, never imputed.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" }, sheet: { type: "string" }, outBase: { type: "string" },
      studentCol: { type: "string" }, currentCol: { type: "string" }, classCol: { type: "string" },
      targetCol: { type: "string" }, previousCol: { type: "string" },
      expectedProgress: { type: "number" }, tolerance: { type: "number" }, anonymize: { type: "boolean" },
    },
    required: ["path", "outBase", "studentCol", "currentCol"],
  },
  risk: () => "medium", // reads student data and writes report files
  describeCall: (a) => `analyse ${String(a["path"])} -> ${String(a["outBase"])}.md/.xlsx${a["anonymize"] === false ? " (NOT anonymised)" : ""}`,
  paths: (a, c) => [resolve(c.cwd, s(a, "path")), dirname(resolve(c.cwd, s(a, "outBase")))],
  async run(a, c) {
    const path = resolve(c.cwd, s(a, "path"));
    const before = createHash("sha256").update(readFileSync(path)).digest("hex");
    const o: AnalyzeOptions = {
      studentCol: s(a, "studentCol"), currentCol: s(a, "currentCol"),
      classCol: opt(a, "classCol"), targetCol: opt(a, "targetCol"), previousCol: opt(a, "previousCol"),
      expectedProgress: typeof a["expectedProgress"] === "number" ? a["expectedProgress"] : undefined,
      tolerance: typeof a["tolerance"] === "number" ? a["tolerance"] : undefined,
      anonymize: a["anonymize"] !== false,
    };
    const table = await readTable(path, opt(a, "sheet"));
    let result = analyze(table, o);
    const check = selfCheck(table, o, result);
    if (!check.ok) return { ok: false, output: `self-check failed: ${check.problems.join("; ")}` };
    if (o.anonymize) result = anonymizeIds(result);
    const files = await writeReport(result, o, path, resolve(c.cwd, s(a, "outBase")));
    const untouched = createHash("sha256").update(readFileSync(path)).digest("hex") === before;
    const ok = existsSync(files.md) && existsSync(files.xlsx) && untouched;
    const summary = {
      rows: result.quality.rows, used: result.quality.usedRows, excluded: result.quality.excluded.length,
      overall: result.overall, classes: result.classes, interventionCount: result.intervention.length, notes: result.notes,
      selfCheck: "passed", sourceUnmodified: untouched, files,
    };
    return { ok, verified: ok, output: JSON.stringify(summary, null, 2), data: summary };
  },
};

export const educationTools: Tool[] = [inspectDocxTool, fillDocxTool, analyzeTableTool];
