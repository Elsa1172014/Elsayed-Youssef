// Checks that each provider URL is reachable (HEAD/GET, 10s timeout). Run from a normal network:
//   node scripts/check-links.mjs
import { readFile } from "node:fs/promises";
const { providers } = JSON.parse(await readFile(new URL("../data/short-drama-providers.json", import.meta.url)));
let bad = 0;
for (const p of providers) {
  try {
    const r = await fetch(p.url, { redirect: "follow", signal: AbortSignal.timeout(10000) });
    console.log(r.ok ? "OK  " : "FAIL", r.status, p.id, r.url);
    if (!r.ok) bad++;
  } catch (e) { console.log("FAIL", p.id, e.message); bad++; }
}
process.exit(bad ? 1 : 0);
