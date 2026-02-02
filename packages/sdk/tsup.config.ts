import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "es2024",
  outDir: "dist",
  splitting: false,
  treeshake: true,
  external: ["@socratic-council/shared"],
});
