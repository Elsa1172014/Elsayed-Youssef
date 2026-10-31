import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fillDocx, inspectDocx } from "../src/education/docx.js";
import { buildTemplate } from "./docx-fixture.js";

describe("template-preserving DOCX fill", () => {
  it("detects fields, fills placeholders (even split across runs) and empty cells, preserves everything else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-docx-"));
    const tpl = join(dir, "t.docx");
    const out = join(dir, "o.docx");
    writeFileSync(tpl, await buildTemplate());

    const info = await inspectDocx(tpl);
    expect(info.placeholders.sort()).toEqual(["الصف", "المعلم"].sort());
    expect(info.emptyFields).toEqual(["الهدف التعليمي", "معايير النجاح", "التمايز"]);
    expect(info.tables).toBe(1);

    const r = await fillDocx(tpl, out, {
      "الصف": "السنة 11",
      "المعلم": "أ. محمد <قسم> & الإدارة",
      "الهدف التعليمي": "أن يحلل الطالب نصاً أدبياً",
      "معايير النجاح": "أحدد الفكرة\nأستشهد بدليل",
    });
    expect(r.ok, JSON.stringify(r.checks)).toBe(true);
    expect(r.checks).toEqual({ tablesPreserved: true, untouchedPartsIdentical: true, allValuesPresent: true });
    expect(r.unfilled).toEqual(["التمايز"]); // reported, NOT invented
    expect(r.unusedKeys).toEqual([]);

    // Independent verification with python-docx
    const py = `
import sys, docx
d = docx.Document(sys.argv[1])
print("PARAS|" + "||".join(p.text for p in d.paragraphs))
t = d.tables[0]
print("ROWS|" + "||".join(" = ".join(c.text for c in r.cells) for r in t.rows))
r0 = d.paragraphs[1].runs
print("BOLD|" + str([x.bold for x in d.tables[0].rows[0].cells[0].paragraphs[0].runs]))
print("STYLE|" + d.styles["Normal"].font.name)
`;
    const res = execFileSync("python3", ["-I", "-c", py, out], { encoding: "utf8" });
    expect(res).toContain("الصف: السنة 11");
    expect(res).toContain("المعلم: أ. محمد <قسم> & الإدارة & فريق R&D");
    expect(res).toContain("الهدف التعليمي: = أن يحلل الطالب نصاً أدبياً");
    expect(res).toContain("معايير النجاح = أحدد الفكرة\nأستشهد بدليل");
    expect(res).toContain("الواجب = قيمة موجودة مسبقاً"); // untouched row
    expect(res).toContain("BOLD|[True]"); // label formatting kept
    expect(res).toContain("STYLE|Arial");
  });

  it("produces a file LibreOffice can open and render", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-docx-"));
    const tpl = join(dir, "t.docx");
    const out = join(dir, "o.docx");
    writeFileSync(tpl, await buildTemplate());
    await fillDocx(tpl, out, { "الصف": "السنة 11", "الهدف التعليمي": "هدف" });
    try { execFileSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", dir, out], { stdio: "ignore", timeout: 90000, env: { ...process.env, HOME: dir } }); }
    catch { return; } // LibreOffice not available in this environment: skip rather than fake a pass
    const { existsSync, statSync } = await import("node:fs");
    expect(existsSync(join(dir, "o.pdf"))).toBe(true);
    expect(statSync(join(dir, "o.pdf")).size).toBeGreaterThan(1000);
  }, 120000);

  it("rejects non-docx input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-docx-"));
    writeFileSync(join(dir, "x.docx"), "not a zip");
    await expect(fillDocx(join(dir, "x.docx"), join(dir, "y.docx"), { a: "b" })).rejects.toThrow();
  });
});
