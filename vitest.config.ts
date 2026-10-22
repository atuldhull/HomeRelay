import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@homerelay/shared": path.resolve(import.meta.dirname, "packages/shared/src/index.ts") } },
  test: { include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"], testTimeout: 20000, hookTimeout: 20000 },
});
