import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.js";

/**
 * Windows desktop control through documented APIs (PowerShell, .NET, user32).
 * Arguments are passed as environment variables, never interpolated into script text.
 * NOTE: these tools only register on win32 and require an interactive desktop session.
 */
function ps(script: string, env: Record<string, string>, ctx: ToolContext, timeoutMs = 30_000): Promise<ToolResult> {
  return new Promise((done) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const t = setTimeout(() => {
      child.kill();
      done({ ok: false, output: `${out}\n[timed out]` });
    }, timeoutMs);
    ctx.signal.addEventListener("abort", () => child.kill(), { once: true });
    child.on("close", (code) => {
      clearTimeout(t);
      done({ ok: code === 0, output: out.trim() });
    });
    child.on("error", (e) => {
      clearTimeout(t);
      done({ ok: false, output: e.message });
    });
  });
}

const USER32 = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W { 
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@`;

export const openAppTool: Tool = {
  name: "open_app",
  group: "desktop",
  description: "Launch an application by executable name or path (e.g. notepad.exe) and confirm its process started.",
  inputSchema: {
    type: "object",
    properties: { app: { type: "string" }, arguments: { type: "string" } },
    required: ["app"],
  },
  risk: () => "medium",
  describeCall: (a) => `launch ${String(a["app"])} ${String(a["arguments"] ?? "")}`,
  async run(a, ctx) {
    const script = `
$p = if ($env:NX_ARGS) { Start-Process -FilePath $env:NX_APP -ArgumentList $env:NX_ARGS -PassThru } else { Start-Process -FilePath $env:NX_APP -PassThru }
Start-Sleep -Milliseconds 1200
$alive = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
if ($alive) { "started pid=$($p.Id) name=$($alive.ProcessName)" } else { "process exited immediately"; exit 1 }`;
    const r = await ps(script, { NX_APP: String(a["app"]), NX_ARGS: String(a["arguments"] ?? "") }, ctx);
    return { ...r, verified: r.ok };
  },
};

export const listWindowsTool: Tool = {
  name: "list_windows",
  group: "desktop",
  description: "List visible top-level windows (title, process, pid).",
  inputSchema: { type: "object", properties: {} },
  risk: () => "low",
  describeCall: () => "list windows",
  run: (_a, ctx) =>
    ps(
      `Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id,ProcessName,MainWindowTitle | Format-Table -AutoSize | Out-String`,
      {},
      ctx,
    ),
};

export const focusWindowTool: Tool = {
  name: "focus_window",
  group: "desktop",
  description: "Bring the first window whose title contains the given text to the foreground.",
  inputSchema: { type: "object", properties: { title_contains: { type: "string" } }, required: ["title_contains"] },
  risk: () => "medium",
  describeCall: (a) => `focus window '${String(a["title_contains"])}'`,
  async run(a, ctx) {
    const script = `${USER32}
$w = Get-Process | Where-Object { $_.MainWindowTitle -like "*$($env:NX_TITLE)*" } | Select-Object -First 1
if (-not $w) { "no window matches"; exit 1 }
[void][W]::SetForegroundWindow($w.MainWindowHandle); "focused: $($w.MainWindowTitle)"`;
    return ps(script, { NX_TITLE: String(a["title_contains"]) }, ctx);
  },
};

export const typeTextTool: Tool = {
  name: "type_text",
  group: "desktop",
  description:
    "Type text into the focused window via clipboard paste (reliable for Arabic/Unicode). Overwrites the clipboard.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  risk: () => "medium",
  describeCall: (a) => `type ${String(a["text"] ?? "").length} chars into focused window`,
  async run(a, ctx) {
    const script = `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText($env:NX_TEXT)
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait("^v"); "pasted"`;
    return ps(script, { NX_TEXT: String(a["text"] ?? "") }, ctx);
  },
};

export const sendKeysTool: Tool = {
  name: "send_keys",
  group: "desktop",
  description: "Send a key sequence to the focused window using SendKeys syntax (e.g. '^s' = Ctrl+S, '{ENTER}').",
  inputSchema: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] },
  risk: () => "medium",
  describeCall: (a) => `send keys ${String(a["keys"])}`,
  async run(a, ctx) {
    return ps(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait($env:NX_KEYS); "sent"`,
      { NX_KEYS: String(a["keys"]) },
      ctx,
    );
  },
};

export const mouseClickTool: Tool = {
  name: "mouse_click",
  group: "desktop",
  description: "Move the cursor to absolute screen coordinates and click (left/right, optional double).",
  inputSchema: {
    type: "object",
    properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string" }, double: { type: "boolean" } },
    required: ["x", "y"],
  },
  risk: () => "medium",
  describeCall: (a) => `click ${String(a["button"] ?? "left")} at (${String(a["x"])}, ${String(a["y"])})`,
  async run(a, ctx) {
    const right = a["button"] === "right";
    const down = right ? 0x08 : 0x02;
    const up = right ? 0x10 : 0x04;
    const times = a["double"] === true ? 2 : 1;
    const script = `${USER32}
[void][W]::SetCursorPos([int]$env:NX_X,[int]$env:NX_Y)
1..$env:NX_N | ForEach-Object { [W]::mouse_event($env:NX_D,0,0,0,[UIntPtr]::Zero); [W]::mouse_event($env:NX_U,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 80 }
"clicked"`;
    return ps(
      script,
      { NX_X: String(Math.round(Number(a["x"]))), NX_Y: String(Math.round(Number(a["y"]))), NX_D: String(down), NX_U: String(up), NX_N: String(times) },
      ctx,
    );
  },
};

export const screenshotTool: Tool = {
  name: "screenshot",
  group: "desktop",
  description: "Capture the full virtual screen (all monitors) to a PNG file and return its path and size.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  risk: () => "medium",
  describeCall: (a) => `capture screen to ${String(a["path"])}`,
  paths: (a, c) => [resolve(c.cwd, String(a["path"]))],
  async run(a, ctx) {
    const target = resolve(ctx.cwd, String(a["path"]));
    mkdirSync(dirname(target), { recursive: true });
    const script = `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save($env:NX_OUT, [System.Drawing.Imaging.ImageFormat]::Png); "$($b.Width)x$($b.Height)"`;
    const r = await ps(script, { NX_OUT: target }, ctx);
    const ok = r.ok && existsSync(target) && statSync(target).size > 0;
    return { ok, verified: ok, output: ok ? `saved ${target} (${r.output})` : `screenshot failed: ${r.output}` };
  },
};

export const desktopTools: Tool[] = [
  openAppTool, listWindowsTool, focusWindowTool, typeTextTool, sendKeysTool, mouseClickTool, screenshotTool,
];
