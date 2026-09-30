import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    watch: false,
    isolate: true,
    reporters: ["default"],
    exclude: ["**/node_modules/**", "**/dist/**", "apps/web/e2e/**"],
    setupFiles: [join(rootDir, "packages/persistence/src/pg-date-parser-setup.ts")],
    sequence: {
      shuffle: false,
    },
  },
});
