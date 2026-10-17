import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests only — pure logic, no I/O, no database, no network, no LLM.
 * Model quality is measured by a separate eval harness, which costs money and
 * is deliberately not part of the test suite.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
