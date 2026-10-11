import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./", // relative asset paths so packaged Tizen/webOS apps load from the file system
  plugins: [react()],
  server: { proxy: { "/v1": "http://localhost:3000" } },
});
