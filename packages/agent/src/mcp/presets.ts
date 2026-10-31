import type { McpServerConfig, RiskRule } from "./hub.js";

const r = (tool: string, arg: string, risk: RiskRule["risk"], values: string[]): RiskRule => ({ tool, arg, in: values, risk });

/**
 * Risk policy for sbroenne/mcp-windows (MIT, .NET, Windows UI Automation), derived from reading its
 * source at commit 75aced9 (the *Action enums under its Models folders). The server has no network
 * or telemetry code. `app` can launch any executable (UseShellExecute=true), so it is high risk
 * unless the program is on a short known-harmless list.
 */
export function windowsMcpPreset(command: string, extraArgs: string[] = []): McpServerConfig {
  return {
    command,
    args: extraArgs,
    readOnlyTools: ["ui_snapshot", "ui_find", "ui_read", "ui_read_table", "ui_wait"],
    // Everything else defaults to medium (approval in `ask` mode).
    highRiskTools: ["app"],
    riskRules: [
      r("app", "programPath", "medium", ["notepad.exe", "notepad", "calc.exe", "mspaint.exe", "winword.exe", "excel.exe", "powerpnt.exe"]),
      r("process", "action", "low", ["list"]),
      r("process", "action", "high", ["kill"]),
      r("window_management", "action", "low", ["list", "find", "getforeground", "getstate", "waitfor", "waitforstate"]),
      r("window_management", "action", "high", ["close"]),
      r("mouse_control", "action", "low", ["getposition"]),
      r("keyboard_control", "action", "low", ["getkeyboardlayout", "waitforidle"]),
      r("clipboard", "action", "medium", ["get", "set", "clear"]),
      r("screenshot_control", "action", "medium", ["capture", "screenshot"]),
    ],
  };
}
