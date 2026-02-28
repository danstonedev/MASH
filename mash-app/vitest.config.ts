import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: true, // Optional if importing from vitest, but helpful for existing codebase assumptions
    setupFiles: ["fake-indexeddb/auto"],
  },
});
