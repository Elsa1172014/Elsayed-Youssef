import { describe, expect, it } from "vitest";
import { databaseUrl } from "../src/openDb";

describe("databaseUrl", () => {
  it("prefers DATABASE_URL, then POSTGRES_URL", () => {
    expect(databaseUrl({ DATABASE_URL: "postgres://a", POSTGRES_URL: "postgres://b" })).toBe("postgres://a");
    expect(databaseUrl({ POSTGRES_URL: "postgres://b" })).toBe("postgres://b");
  });
  it("finds Neon variables created with a custom prefix, preferring pooled ones", () => {
    expect(databaseUrl({ STORAGE_URL: "postgres://x", STORAGE_URL_UNPOOLED: "postgres://u" })).toBe("postgres://x");
    expect(databaseUrl({ STORAGE_DATABASE_URL_UNPOOLED: "postgres://u", STORAGE_DATABASE_URL: "postgres://p" })).toBe("postgres://p");
    expect(databaseUrl({ STORAGE_POSTGRES_URL: "postgres://p", STORAGE_POSTGRES_URL_NON_POOLING: "postgres://n" })).toBe("postgres://p");
  });
  it("ignores unrelated URLs and returns undefined when none", () => {
    expect(databaseUrl({ IPTV_ORG_API: "https://iptv-org.github.io/api", SITE_URL: "https://x" })).toBeUndefined();
  });
});
