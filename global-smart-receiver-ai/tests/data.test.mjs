import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = async f => JSON.parse(await readFile(new URL(`../data/${f}`, import.meta.url)));

test("providers: unique ids, https only, no unverified claim of verification", async () => {
  const { providers } = await load("short-drama-providers.json");
  assert.equal(new Set(providers.map(p => p.id)).size, providers.length);
  for (const p of providers) {
    assert.equal(new URL(p.url).protocol, "https:");
    assert.equal(typeof p.verified, "boolean");
  }
});

test("own content: every episode is https and series have a license", async () => {
  const { series } = await load("short-dramas-own.json");
  for (const s of series) {
    assert.ok(s.license, `series ${s.id} needs a license`);
    for (const e of s.episodes) assert.equal(new URL(e.src).protocol, "https:");
  }
});
