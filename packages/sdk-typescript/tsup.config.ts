import { defineConfig } from "tsup";

// The SDK has zero runtime dependencies (it uses the platform fetch / WebSocket
// / crypto globals), so everything bundles cleanly into ESM + CJS with types.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
});
