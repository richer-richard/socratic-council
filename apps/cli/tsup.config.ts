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
  banner: {
    js: "#!/usr/bin/env node",
  },
});
