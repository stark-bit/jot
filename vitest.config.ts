import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/protocol/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
