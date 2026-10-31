# @receiver/agent — AI NEXUS local agent

A computer-use agent that plans, acts through tools, **verifies**, and reports honestly.
Runs on **Windows** (desktop control via PowerShell/.NET/user32), **Linux/macOS** (files, shell, system, web), and exposes a **local web control center**. Extensible with any **MCP** server.

## Quick start
```bash
cd packages/agent && npm ci && npm run build
export ANTHROPIC_API_KEY=...          # or OPENAI_API_KEY / OPENROUTER_API_KEY / OLLAMA_MODEL=llama3.1
node dist/cli.js run "اكتب ملاحظة قصيرة بالعربية في Documents/note.txt وتحقق من وجودها"
node dist/cli.js serve                # web control center (prints a URL with a private token)
```
Dev: `npm run nexus -- run "..."`, `npm test`, `npm run typecheck`.

## What is implemented (and tested)
| Area | Status |
|---|---|
| Agent loop: plan → permission → execute → verify → recover → report | ✅ tested (scripted model) |
| Budgets: steps, time, identical-call loop detection; cancellation | ✅ tested |
| Persistent tasks (SQLite) + checkpoint per step + resume after crash | ✅ tested |
| Permissions: risk levels, modes (ask/auto/readonly), path sandbox, hard-blocked commands, tool revocation | ✅ tested |
| Audit log (JSONL, secrets redacted) | ✅ tested |
| Files: read/list/search/write(+verify, backup)/move/delete→recoverable trash | ✅ tested |
| Shell (PowerShell on Windows, sh elsewhere), system info, processes, SSRF-guarded `web_fetch` | ✅ tested (shell/system partly) |
| MCP hub: stdio + streamable HTTP, discovery, per-tool risk, health ping, revoke on disconnect | ✅ tested with a real stdio server |
| Multi-agent: `delegate` to computer / coder / researcher specialists (tool-group scoped, no recursion) | ✅ built; sub-agent loop shares the tested loop |
| Providers: Anthropic, OpenAI-compatible (OpenAI, OpenRouter, Ollama, Gemini-compat, xAI), ordered fallback | ✅ request mapping built; **not yet run against live APIs** |
| Web control center: token auth, loopback only, Host check, SSE, approvals, emergency stop | ✅ tested end-to-end |
| Education: `inspect_docx` / `fill_docx` — fills the teacher's own Word template (placeholders split across runs, empty table cells), keeps layout/RTL/fonts, leaves unknown fields blank and reports them; output re-opened and checked; verified independently with python-docx and LibreOffice | ✅ tested (synthetic Arabic template; **try it on your real templates**) |
| Data: `analyze_table` (CSV/XLSX) — quality, attainment vs target, progress vs previous (only with a threshold you give), per-class evidence quality, intervention list, traceable calculations, live Excel formulas, anonymised by default, source never modified | ✅ tested against hand-computed numbers; formulas checked with openpyxl |
| `mcp-windows` integration (UI Automation by element name): argument-aware risk (`process.kill`, `window_management.close`, `app` → high; reads → low) via `nexus preset windows <exe>` | ✅ risk logic tested; ⚠️ **server itself not run** (needs Windows) |
| Windows desktop: open_app, list/focus window, type_text (Unicode via clipboard), send_keys, mouse_click, screenshot | ⚠️ **written, not yet executed on Windows** (`test/desktop.win.test.ts` runs in CI on windows-latest) |

## Not built yet (honest backlog)
Electron shell, OCR, PowerPoint/PDF/QR generation, multi-sheet/PDF-table input, model router by task type, usage/cost dashboard, GitHub/Vercel/Microsoft 365 connectors (use their MCP servers via `mcpServers`), cloud workers & device registration, Windows Credential Manager, encrypted backups, installer.

## Configuration — `~/.ai-nexus/config.json`
```json
{
  "mode": "ask",
  "allowedRoots": ["C:\\Users\\me\\Documents"],
  "providers": [
    {"type":"anthropic","name":"anthropic","model":"claude-sonnet-5-5","apiKeyEnv":"ANTHROPIC_API_KEY"},
    {"type":"openai","name":"ollama","model":"llama3.1","baseUrl":"http://127.0.0.1:11434/v1"}
  ],
  "mcpServers": {
    "windows": {"command":"C:\\tools\\mcp-windows\\server.exe","readOnlyTools":["list_windows"]},
    "fs-notes": {"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","C:\\Users\\me\\Notes"]}
  }
}
```
API keys are read from environment variables only. MCP servers get a minimal environment (no inherited secrets). MCP tools default to **medium** risk (approval in `ask` mode); mark safe ones in `readOnlyTools`, outward-facing ones in `highRiskTools`.

## Security model
- **Risk**: low = read-only; medium = create/modify; high = overwrite, delete, arbitrary commands, external sends. `ask` mode prompts for medium+high; `auto` only high; `readonly` denies all but low.
- **Hard blocks** (never run, never prompted): `rm -rf /`, `mkfs`, Defender/firewall disabling, `bcdedit`, pipe-to-shell downloads.
- **Path sandbox** for file tools: cwd, `~/Documents`, `~/.ai-nexus/workspace`, plus `allowedRoots`. **`run_command` is not path-sandboxed**: it is high risk (approval) unless it is a plain read-only command; do not use `auto` mode with untrusted prompts.
- **Prompt injection**: all tool output is wrapped as untrusted data and the system prompt forbids obeying it; permissions are enforced in code, not by the model.
- **Web UI**: 127.0.0.1 only, random bearer token per run, Host-header check, no CORS. The token travels in the URL fragment (not sent to the server in the page request).
- No elevation, no bypass of UAC/Defender/enterprise policy.

## Using mcp-windows (reviewed at commit 75aced9)
Source review: MIT, no network or telemetry code, no registry writes; `app` launches any executable (`UseShellExecute=true`) and `process` can kill processes, so both are gated by our permission engine. It cannot control elevated windows unless it is itself elevated (do not do that). Install it from its GitHub Releases, then:
```bash
node dist/cli.js preset windows "C:\\tools\\mcp-windows\\Sbroenne.WindowsMcp.exe"   # paste the output into ~/.ai-nexus/config.json
node dist/cli.js mcp                                                                     # confirm tools are discovered
```
