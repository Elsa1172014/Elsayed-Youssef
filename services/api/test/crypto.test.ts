import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveSecretKey, secretBoxFromEnv } from "../src/crypto";

describe("SECRET_KEY handling", () => {
  it("uses a valid 32-byte base64 value as-is", () => {
    const key = randomBytes(32);
    expect(deriveSecretKey(key.toString("base64")).equals(key)).toBe(true);
  });
  it("derives a stable 32-byte key from any other text instead of failing", () => {
    const a = deriveSecretKey("my plain text secret");
    expect(a).toHaveLength(32);
    expect(deriveSecretKey("my plain text secret").equals(a)).toBe(true);
    expect(deriveSecretKey("another secret").equals(a)).toBe(false);
  });
  it("trims whitespace and rejects an empty value", () => {
    expect(deriveSecretKey("  abc  ").equals(deriveSecretKey("abc"))).toBe(true);
    expect(() => deriveSecretKey("   ")).toThrow("SECRET_KEY is required");
    expect(() => secretBoxFromEnv({})).toThrow("SECRET_KEY is required");
  });
  it("round-trips secrets with a derived key", () => {
    const box = secretBoxFromEnv({ SECRET_KEY: "plain text works" });
    expect(box.open(box.seal("xtream-password"))).toBe("xtream-password");
  });
});
