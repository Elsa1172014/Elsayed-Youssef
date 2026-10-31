import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Tool, ToolContext } from "../types.js";

const MAX_READ = 200_000;
const str = (a: Record<string, unknown>, k: string): string => {
  const v = a[k];
  if (typeof v !== "string" || v === "") throw new Error(`missing string argument '${k}'`);
  return v;
};
const abs = (p: string, ctx: ToolContext): string => resolve(ctx.cwd, p);
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

export const readFileTool: Tool = {
  name: "read_file",
  group: "files",
  description: "Read a UTF-8 text file (truncated at 200k chars).",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  risk: () => "low",
  describeCall: (a) => `read ${String(a["path"])}`,
  paths: (a, c) => [abs(str(a, "path"), c)],
  async run(a, c) {
    const p = abs(str(a, "path"), c);
    const text = readFileSync(p, "utf8");
    return { ok: true, output: text.length > MAX_READ ? text.slice(0, MAX_READ) + "\n…[truncated]" : text };
  },
};

export const listDirTool: Tool = {
  name: "list_dir",
  group: "files",
  description: "List entries of a directory with type and size.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  risk: () => "low",
  describeCall: (a) => `list ${String(a["path"])}`,
  paths: (a, c) => [abs(str(a, "path"), c)],
  async run(a, c) {
    const p = abs(str(a, "path"), c);
    const rows = readdirSync(p, { withFileTypes: true }).map((e) => {
      const full = join(p, e.name);
      const size = e.isFile() ? statSync(full).size : 0;
      return `${e.isDirectory() ? "d" : "f"}\t${size}\t${e.name}`;
    });
    return { ok: true, output: rows.join("\n") || "(empty)" };
  },
};

export const searchFilesTool: Tool = {
  name: "search_files",
  group: "files",
  description: "Recursively find files whose name contains a substring (max 200 results).",
  inputSchema: {
    type: "object",
    properties: { root: { type: "string" }, name_contains: { type: "string" } },
    required: ["root", "name_contains"],
  },
  risk: () => "low",
  describeCall: (a) => `search '${String(a["name_contains"])}' under ${String(a["root"])}`,
  paths: (a, c) => [abs(str(a, "root"), c)],
  async run(a, c) {
    const needle = str(a, "name_contains").toLowerCase();
    const hits: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (hits.length >= 200 || depth > 12) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const full = join(dir, e.name);
        if (e.name.toLowerCase().includes(needle)) hits.push(full);
        if (e.isDirectory()) walk(full, depth + 1);
      }
    };
    walk(abs(str(a, "root"), c), 0);
    return { ok: true, output: hits.join("\n") || "no matches" };
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  group: "files",
  description:
    "Create or overwrite a UTF-8 text file. Parent folders are created. The result confirms the file exists and its size/hash were re-read from disk.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
  risk: (a, c) => (typeof a["path"] === "string" && existsSync(abs(a["path"], c)) ? "high" : "medium"),
  describeCall: (a) => `write ${String(a["path"])} (${String(a["content"] ?? "").length} chars)`,
  paths: (a, c) => [abs(str(a, "path"), c)],
  async run(a, c) {
    const p = abs(str(a, "path"), c);
    const content = typeof a["content"] === "string" ? a["content"] : "";
    mkdirSync(dirname(p), { recursive: true });
    let backup = "";
    if (existsSync(p)) {
      backup = `${p}.nexus-bak-${Date.now()}`;
      writeFileSync(backup, readFileSync(p));
    }
    writeFileSync(p, content, "utf8");
    // Verify by reading back from disk.
    const back = readFileSync(p);
    const ok = existsSync(p) && back.toString("utf8") === content;
    return {
      ok,
      verified: ok,
      output: ok
        ? `written and verified: ${p} (${back.length} bytes, sha256 ${sha(back).slice(0, 12)})${backup ? `; previous version kept at ${backup}` : ""}`
        : `write verification FAILED for ${p}`,
      data: { path: p, bytes: back.length },
    };
  },
};

export const moveFileTool: Tool = {
  name: "move_file",
  group: "files",
  description: "Move or rename a file or folder. Refuses to overwrite an existing target.",
  inputSchema: {
    type: "object",
    properties: { from: { type: "string" }, to: { type: "string" } },
    required: ["from", "to"],
  },
  risk: () => "medium",
  describeCall: (a) => `move ${String(a["from"])} -> ${String(a["to"])}`,
  paths: (a, c) => [abs(str(a, "from"), c), abs(str(a, "to"), c)],
  async run(a, c) {
    const from = abs(str(a, "from"), c);
    const to = abs(str(a, "to"), c);
    if (!existsSync(from)) return { ok: false, output: `source not found: ${from}` };
    if (existsSync(to)) return { ok: false, output: `target already exists: ${to}` };
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    const ok = existsSync(to) && !existsSync(from);
    return { ok, verified: ok, output: ok ? `moved to ${to}` : "move verification failed" };
  },
};

export const deleteFileTool: Tool = {
  name: "delete_path",
  group: "files",
  description:
    "Delete a file or folder by moving it to the recoverable trash (never permanent). Returns the trash location for restore.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  risk: () => "high",
  describeCall: (a) => `move to trash: ${String(a["path"])}`,
  paths: (a, c) => [abs(str(a, "path"), c)],
  async run(a, c) {
    const p = abs(str(a, "path"), c);
    if (!existsSync(p)) return { ok: false, output: `not found: ${p}` };
    mkdirSync(c.trashDir, { recursive: true });
    const dest = join(c.trashDir, `${Date.now()}-${basename(p)}`);
    renameSync(p, dest);
    const ok = !existsSync(p) && existsSync(dest);
    return { ok, verified: ok, output: ok ? `moved to trash: ${dest} (original: ${p})` : "trash move failed" };
  },
};

export const fileTools: Tool[] = [
  readFileTool,
  listDirTool,
  searchFilesTool,
  writeFileTool,
  moveFileTool,
  deleteFileTool,
];
