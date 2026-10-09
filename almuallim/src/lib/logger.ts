/** Minimal structured JSON logger with redaction. One line per event; safe for Vercel and container logs. */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Keys whose values must never be logged (secrets and student/book content).
const REDACT = /(authorization|cookie|token|secret|api[-_]?key|password|apikey|transcript|content|text|prompt|response|audio|image|frame|email)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 300) return value.slice(0, 300) + "…";
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(
  bindings: Record<string, unknown> = {},
  sink: (line: string) => void = (l) => process.stdout.write(l + "\n"),
  minLevel: Level = (process.env.LOG_LEVEL as Level) || "info",
): Logger {
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact(bindings) as object), ...(redact(fields ?? {}) as object) }));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (b) => createLogger({ ...bindings, ...b }, sink, minLevel),
  };
}

export const logger = createLogger({ app: "almuallim" });
