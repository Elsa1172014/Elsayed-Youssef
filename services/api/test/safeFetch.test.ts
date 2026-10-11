import { describe, expect, it } from "vitest";
import { aesSecretBox } from "../src/crypto";
import { createSafeFetch } from "../src/safeFetch";

const resp = (status: number, body = "", headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

describe("safeFetch", () => {
  it("fetches public hosts", async () => {
    const f = createSafeFetch({ resolve: async () => ["93.184.216.34"], fetchImpl: (async () => resp(200, "hello")) as typeof fetch });
    expect(await (await f("https://example.org/x")).text()).toBe("hello");
  });
  it("blocks hosts resolving to private addresses", async () => {
    const f = createSafeFetch({ resolve: async () => ["10.0.0.5"], fetchImpl: (async () => resp(200)) as typeof fetch });
    await expect(f("https://evil.example/x")).rejects.toThrow(/private/i);
  });
  it("re-validates redirects", async () => {
    const f = createSafeFetch({
      resolve: async () => ["93.184.216.34"],
      fetchImpl: (async () => resp(302, "", { location: "http://169.254.169.254/latest" })) as typeof fetch,
    });
    await expect(f("https://example.org/x")).rejects.toThrow();
  });
  it("rejects non-http schemes and oversized bodies", async () => {
    const f = createSafeFetch({ resolve: async () => ["93.184.216.34"], fetchImpl: (async () => resp(200, "x".repeat(21 * 1024 * 1024))) as typeof fetch });
    await expect(f("file:///etc/passwd")).rejects.toThrow();
    await expect((await f("https://example.org/big")).text()).rejects.toThrow(/too large/i);
  });
});

describe("secret box", () => {
  const box = aesSecretBox(Buffer.alloc(32, 7));
  it("round-trips and detects tampering", () => {
    const sealed = box.seal("secret");
    expect(sealed).not.toContain("secret");
    expect(box.open(sealed)).toBe("secret");
    expect(() => box.open(sealed.slice(0, -4) + "AAAA")).toThrow();
    expect(box.seal("secret")).not.toBe(sealed); // fresh IV
  });
  it("rejects wrong key sizes", () => {
    expect(() => aesSecretBox(Buffer.alloc(16))).toThrow();
  });
});
