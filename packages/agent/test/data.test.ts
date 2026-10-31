import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { analyze, anonymizeIds, parseCsv, readTable, selfCheck, type AnalyzeOptions } from "../src/education/data.js";
import { analyzeTableTool } from "../src/education/tools.js";

const CSV = `الطالب,الصف,الحالي,المستهدف,السابق
أحمد,11A,70,65,60
سلمى,11A,65,65,66
عمر,11A,50,65,55
ليلى,11B,80,70,70
نور,11B,غائب,70,68
خالد,11B,60,70,
ياسر,11B,75,,70
أحمد,11A,99,65,60
,11A,60,65,60
`;
const O: AnalyzeOptions = { studentCol: "الطالب", classCol: "الصف", currentCol: "الحالي", targetCol: "المستهدف", previousCol: "السابق" };
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-data-"));
  const csv = join(dir, "marks.csv");
  writeFileSync(csv, CSV);
  return { dir, csv };
};

describe("educational data analysis", () => {
  it("parses quoted CSV fields", () => {
    expect(parseCsv('a,b\n"x,1","he said ""hi"""\n')).toEqual([["a", "b"], ["x,1", 'he said "hi"']]);
  });

  it("matches hand-computed results and never invents data", async () => {
    const { csv } = setup();
    const t = await readTable(csv);
    const a = analyze(t, O);
    expect(a.quality).toMatchObject({ rows: 9, usedRows: 6 });
    expect(a.quality.excluded.map((e) => e.rowNumber).sort((x, y) => x - y)).toEqual([6, 9, 10]);
    expect(a.quality.excluded.find((e) => e.rowNumber === 6)!.reason).toContain("non-numeric");
    expect(a.quality.duplicateIds).toEqual([{ id: "أحمد", rowNumbers: [2, 9] }]);
    const c11a = a.classes.find((c) => c.cls === "11A")!;
    expect(c11a).toMatchObject({ n: 3, meanCurrent: 61.67, meanTarget: 65, below: 1, expected: 1, above: 1 });
    expect(c11a.evidence).toContain("low evidence");
    const c11b = a.classes.find((c) => c.cls === "11B")!;
    expect(c11b).toMatchObject({ n: 3, meanCurrent: 71.67, meanTarget: 70, below: 1, expected: 0, above: 1 });
    expect(a.overall).toMatchObject({ n: 6, meanCurrent: 66.67, below: 2, expected: 1, above: 2, noTarget: 1, belowShare: 40 });
    expect(a.calculations.find((c) => c.name.startsWith("mean progress"))).toMatchObject({ n: 5, result: 3.8 });
    // intervention: below target OR regressed → سلمى (regressed), عمر (below+regressed), خالد (below)
    expect(a.intervention.map((i) => i.id).sort()).toEqual(["خالد", "سلمى", "عمر"].sort());
    // attainment and progress are separate: no progress bands without a threshold
    expect(a.students.every((s) => s.progress === "not-classified" || s.progress === "no-previous")).toBe(true);
    expect(a.notes.join(" ")).toContain("expectedProgress");
    expect(selfCheck(t, O, a).ok).toBe(true);
    // the absent student was excluded, NOT scored as 0
    expect(a.students.find((s) => s.id === "نور")).toBeUndefined();
  });

  it("classifies progress only when a threshold is given", async () => {
    const a = analyze(await readTable(setup().csv), { ...O, expectedProgress: 2 });
    expect(a.students.find((s) => s.id === "أحمد")!.progress).toBe("above");
    expect(a.students.find((s) => s.id === "سلمى")!.progress).toBe("below");
  });

  it("fails clearly on a wrong column name", async () => {
    await expect(async () => analyze(await readTable(setup().csv), { ...O, currentCol: "nope" })).rejects.toThrow(/not found/);
  });

  it("anonymises identifiers consistently", async () => {
    const a = anonymizeIds(analyze(await readTable(setup().csv), O));
    expect(a.students.map((s) => s.id)).toEqual(["S001", "S002", "S003", "S004", "S005", "S006"].slice(0, 6));
    expect(JSON.stringify(a)).not.toContain("سلمى");
  });

  it("tool: reads XLSX, leaves the source untouched, writes .md + .xlsx with live formulas verified by openpyxl", async () => {
    const { dir } = setup();
    const src = join(dir, "marks.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Term1");
    for (const r of parseCsv(CSV)) ws.addRow(r.map((x, i) => (i >= 2 && x !== "" && !Number.isNaN(Number(x)) ? Number(x) : x === "" ? null : x)));
    await wb.xlsx.writeFile(src);
    const hash = () => createHash("sha256").update(readFileSync(src)).digest("hex");
    const h0 = hash();

    const ctx = { signal: new AbortController().signal, cwd: dir, trashDir: join(dir, "t") };
    const r = await analyzeTableTool.run({ path: "marks.xlsx", outBase: "report", ...O, anonymize: true }, ctx);
    expect(r.ok, r.output).toBe(true);
    expect(hash()).toBe(h0);
    const md = readFileSync(join(dir, "report.md"), "utf8");
    expect(md).toContain("61.67");
    expect(md).not.toContain("سلمى"); // anonymised by default
    expect(md).toContain("S001");

    const py = `
import sys, openpyxl
f = openpyxl.load_workbook(sys.argv[1])            # formulas
v = openpyxl.load_workbook(sys.argv[1], data_only=True)  # cached results
c = f["Classes"]; cv = v["Classes"]
print("F|" + str(c["C2"].value))
print("V|" + str(cv["C2"].value) + "|" + str(cv["B2"].value) + "|" + str(cv["D2"].value))
print("SHEETS|" + ",".join(f.sheetnames))
`;
    const out = execFileSync("python3", ["-I", "-c", py, join(dir, "report.xlsx")], { encoding: "utf8" });
    expect(out).toContain("F|=AVERAGEIF(Students!C2:C7,A2,Students!D2:D7)");
    expect(out).toMatch(/V\|61\.67\|3\|1/);
    expect(out).toContain("SHEETS|Students,Classes,Quality,Calculations");
  });
});
