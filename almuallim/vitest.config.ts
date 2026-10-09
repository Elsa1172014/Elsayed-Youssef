import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    environment: "node", // component tests opt in with `// @vitest-environment jsdom`
  },
});
