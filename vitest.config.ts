import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    watch: false,
    isolate: true,
    reporters: ["default"],
    exclude: ["**/node_modules/**", "**/dist/**", "apps/web/e2e/**"],
    sequence: {
      shuffle: false,
    },
  },
});
