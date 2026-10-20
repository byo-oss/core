import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  // clean is done in the build script
  clean: false,
  external: ["better-auth", "@better-auth/core"],
});
