import { defineConfig } from "vitest/config";

// Database tests run against a REAL PostgreSQL 16 + pgvector (see scripts/test-db-cluster.sh).
export default defineConfig({
  test: {
    include: ["tests/db/**/*.test.ts"],
    globalSetup: ["tests/db/global-setup.ts"],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
