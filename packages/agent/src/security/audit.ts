import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /("?(?:api[_-]?key|token|secret|password|authorization)"?\s*[:=]\s*)"?[^"\s,}]{6,}"?/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, p1?: string) => (typeof p1 === "string" ? `${p1}"[REDACTED]"` : "[REDACTED]"));
  }
  return out;
}

export interface AuditEvent {
  taskId?: string;
  kind: "tool_call" | "approval" | "denied" | "result" | "task" | "mcp" | "error";
  tool?: string;
  risk?: string;
  detail: string;
}

/** Append-only JSONL audit log. Secrets are redacted before they touch disk. */
export class AuditLog {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  write(ev: AuditEvent): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...ev, detail: redact(ev.detail).slice(0, 4000) });
    appendFileSync(this.file, line + "\n", { mode: 0o600 });
  }
}
