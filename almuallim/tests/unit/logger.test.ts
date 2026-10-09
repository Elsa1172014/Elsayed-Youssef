import { describe, expect, it } from "vitest";
import { createLogger, redact } from "@/lib/logger";

describe("logger redaction", () => {
  it("redacts credentials and student/book content but keeps usage counters", () => {
    const lines: string[] = [];
    const log = createLogger({ app: "t" }, (l) => lines.push(l), "debug");
    log.info("x", { accessToken: "abc", token: "t", apiKey: "k", transcript: "نص الطالب", text: "x", tokens: 123, totalTokens: 5, userId: "u1", nested: { password: "p", ok: 1 } });
    const o = JSON.parse(lines[0]!);
    expect(o).toMatchObject({ accessToken: "[redacted]", token: "[redacted]", apiKey: "[redacted]", transcript: "[redacted]", text: "[redacted]", tokens: 123, totalTokens: 5, userId: "u1" });
    expect(o.nested).toEqual({ password: "[redacted]", ok: 1 });
  });
  it("truncates long strings, serialises errors safely, respects level", () => {
    expect((redact("a".repeat(500)) as string).length).toBeLessThan(310);
    expect(redact(new Error("boom"))).toEqual({ name: "Error", message: "boom" });
    const lines: string[] = [];
    createLogger({}, (l) => lines.push(l), "warn").info("hidden");
    expect(lines).toHaveLength(0);
  });
});
