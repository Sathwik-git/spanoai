import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    stdio: "src/stdio.ts",
    http: "src/http.ts",
    "http-server": "src/http-server.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  // @spanoai/sdk, the MCP SDK and zod are real dependencies — keep them external.
  external: ["@spanoai/sdk", "@modelcontextprotocol/sdk", "zod"],
});
