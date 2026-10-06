import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for the deterministic rules behind AI intake and bulk import.
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
