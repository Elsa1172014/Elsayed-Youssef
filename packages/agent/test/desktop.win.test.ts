import { execSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listWindowsTool, openAppTool, screenshotTool } from "../src/tools/desktop.js";

// Runs only on Windows (CI windows-latest or the user's PC). Skipped on Linux/macOS.
describe.skipIf(process.platform !== "win32")("Windows desktop tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-win-"));
  const ctx = { signal: new AbortController().signal, cwd: dir, trashDir: join(dir, "trash") };

  it("launches Notepad and verifies the process", async () => {
    const r = await openAppTool.run({ app: "notepad.exe" }, ctx);
    expect(r.ok, r.output).toBe(true);
    expect(r.output).toMatch(/started pid=\d+/);
    execSync("taskkill /IM notepad.exe /F", { stdio: "ignore" });
  }, 30000);

  it("lists windows", async () => {
    expect((await listWindowsTool.run({}, ctx)).ok).toBe(true);
  }, 30000);

  it("captures a screenshot to a PNG that exists", async () => {
    const out = join(dir, "s.png");
    const r = await screenshotTool.run({ path: out }, ctx);
    expect(r.ok, r.output).toBe(true);
    expect(existsSync(out)).toBe(true);
  }, 30000);
});
