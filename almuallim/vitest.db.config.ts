import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Database tests run against a REAL PostgreSQL 16 + pgvector (see scripts/test-db-cluster.sh).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/db/**/*.test.ts"],
    globalSetup: ["tests/db/global-setup.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
