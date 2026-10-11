import { defineConfig } from "vitest/config";

// Explicit config so Vitest does not pick up the repo-root Vite prototype config.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
