// Runs axe-core on the given URLs in headless Chromium. Usage: node scripts/a11y-check.mjs http://localhost:3000/login ...
import { chromium } from "playwright-core";
import { readFileSync, readdirSync } from "node:fs";
const dir = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
const c = readdirSync(dir).find((d) => /^chromium-\d+$/.test(d));
const axe = readFileSync(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const b = await chromium.launch({ executablePath: `${dir}/${c}/chrome-linux/chrome`, args: ["--no-sandbox"] });
let bad = 0;
for (const url of process.argv.slice(2)) {
  for (const scheme of ["light", "dark"]) {
    const p = await (await b.newContext({ colorScheme: scheme })).newPage();
    await p.goto(url);
    await p.evaluate(axe);
    const r = await p.evaluate(() => axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] }));
    console.log(`${url} [${scheme}] violations: ${r.violations.length}`);
    for (const v of r.violations) { bad++; console.log(`  - ${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s) e.g. ${v.nodes[0].target.join(" ")}`); }
  }
}
await b.close();
process.exit(bad ? 1 : 0);
