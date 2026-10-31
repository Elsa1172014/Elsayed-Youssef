import JSZip from "jszip";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const rtlP = (inner: string): string => `<w:p><w:pPr><w:bidi/><w:jc w:val="right"/></w:pPr>${inner}</w:p>`;
const run = (t: string, bold = false): string =>
  `<w:r><w:rPr>${bold ? "<w:b/>" : ""}<w:rtl/><w:color w:val="1F3864"/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
const cell = (inner: string): string => `<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${inner}</w:tc>`;
const emptyCell = (): string => cell(`<w:p><w:pPr><w:bidi/><w:jc w:val="right"/></w:pPr></w:p>`);

export async function buildTemplate(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Arial" w:cs="Arial"/><w:sz w:val="24"/></w:rPr></w:style></w:styles>`);
  const body =
    rtlP(run("خطة درس – اللغة العربية", true)) +
    // placeholder split across three runs, as Word often does
    rtlP(run("الصف: ") + run("{{", true) + run("الصف") + run("}}", true)) +
    `<w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>` +
    `<w:tr>${cell(rtlP(run("الهدف التعليمي:", true)))}${emptyCell()}</w:tr>` +
    `<w:tr>${cell(rtlP(run("معايير النجاح", true)))}${emptyCell()}</w:tr>` +
    `<w:tr>${cell(rtlP(run("التمايز", true)))}${emptyCell()}</w:tr>` +
    `<w:tr>${cell(rtlP(run("الواجب", true)))}${cell(rtlP(run("قيمة موجودة مسبقاً")))}</w:tr>` +
    `</w:tbl>` +
    rtlP(run("المعلم: {{المعلم}} &amp; فريق R&amp;D"));
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
