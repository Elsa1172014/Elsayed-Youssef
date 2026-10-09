// Generates tiny, ORIGINAL Arabic textbook PDFs used as test fixtures (no copyrighted content).
// Usage: node scripts/make-fixture-pdf.mjs   (needs Chromium; uses PLAYWRIGHT_BROWSERS_PATH or /opt/pw-browsers)
import { chromium } from "playwright-core";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
const chromeDir = readdirSync(browsersDir).find((d) => /^chromium-\d+$/.test(d));
const executablePath = join(browsersDir, chromeDir, "chrome-linux", "chrome");

const pages = [
  // 1: cover
  `<h1 class="cover">لغتي العربية — الصف التاسع</h1><p class="c">كتاب تجريبي أصلي لاختبار النظام</p>`,
  // 2: unit + lesson 1 start
  `<h1>الوحدة الأولى: قواعد الجملة الفعلية</h1>
   <h2>الدرس الأول: الفاعل</h2>
   <p>الفاعل اسم مرفوع يدل على من قام بالفعل أو اتصف به، ويأتي بعد الفعل مباشرة. نقول: كتبَ الطالبُ الدرسَ، فكلمة الطالبُ فاعل مرفوع بالضمة.</p>
   <p>قد يكون الفاعل اسمًا ظاهرًا مثل: حضرَ المعلمُ، وقد يكون ضميرًا متصلًا مثل: كتبتُ الرسالةَ.</p>`,
  // 3: lesson 1 continues + exercise
  `<p>ملاحظة: يبقى الفعل مفردًا مع الفاعل مهما كان عدد الفاعلين، فنقول: نجحَ الطلابُ، ولا نقول: نجحوا الطلابُ.</p>
   <h3>تدريب</h3>
   <p>١- استخرج الفاعل من الجملة: قرأَ الأولادُ القصةَ في المكتبة.</p>
   <p>٢- ضع فاعلًا مناسبًا في الفراغ: ينمو ........ في الربيع.</p>`,
  // 4: lesson 2
  `<h2>الدرس الثاني: المفعول به</h2>
   <p>المفعول به اسم منصوب يقع عليه فعل الفاعل. نقول: فتحَ الطالبُ البابَ، فكلمة البابَ مفعول به منصوب بالفتحة.</p>
   <p>علامات النصب الأصلية هي الفتحة، وفي جمع المؤنث السالم الكسرة نيابة عن الفتحة، مثل: رأيتُ المعلماتِ.</p>`,
  // 5: lesson 2 exercise
  `<h3>تدريب</h3>
   <p>١- أعرب ما تحته خط: أكلَ الولدُ التفاحةَ.</p>
   <p>٢- كوّن جملة فعلية فيها فاعل ومفعول به عن موضوع المدرسة.</p>`,
  // 6: lesson 3 poem
  `<h2>الدرس الثالث: نص شعري — العلم نور</h2>
   <p class="poem">العلمُ نورٌ يضيءُ الدربَ للأممِ<br/>والجهلُ ظلٌّ يغطّي صفحةَ القِيَمِ</p>
   <p>المفردات: يضيء: ينير. يغطّي: يستر. القيم: المبادئ الحسنة.</p>`,
];

const arabicDigits = (n) => String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[d]);
const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
@page { size: A5; margin: 18mm 14mm 22mm; }
body { font-family: "DejaVu Sans", "FreeSerif", sans-serif; font-size: 12pt; line-height: 1.9; }
h1 { font-size: 22pt; margin: 0 0 8mm; } h2 { font-size: 17pt; margin: 4mm 0; } h3 { font-size: 14pt; }
.cover { margin-top: 40mm; text-align: center; } .c { text-align: center; }
.pg { page-break-after: always; position: relative; height: 156mm; overflow: hidden; }
.num { position: absolute; bottom: 0; width: 100%; text-align: center; font-size: 10pt; }
</style></head><body>${pages
  .map((p, i) => `<section class="pg">${p}${i === 0 ? "" : `<div class="num">${arabicDigits(i + 1)}</div>`}</section>`)
  .join("")}</body></html>`;

const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setContent(html);
for (const [name, outline] of [["sample-textbook.pdf", true], ["sample-textbook-noutline.pdf", false]]) {
  const pdf = await page.pdf({ format: "A5", printBackground: true, outline, tagged: outline, displayHeaderFooter: false, preferCSSPageSize: true });
  writeFileSync(join("tests/fixtures", name), pdf);
  console.log(name, pdf.length, "bytes");
}
// Image-only / empty PDF: no text layer (stands in for a scanned book).
await page.setContent("<html><body style='margin:0'><div style='width:100px;height:100px;background:#ccc'></div></body></html>");
writeFileSync(join("tests/fixtures", "no-text.pdf"), await page.pdf({ format: "A5" }));
console.log("no-text.pdf");
await browser.close();
