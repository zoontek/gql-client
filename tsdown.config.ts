import { defineConfig } from "tsdown";

export default defineConfig({
  platform: "neutral",
  entry: "./src/**",
  outDir: "./dist",
  deps: { neverBundle: true },
  minify: false,
  sourcemap: true,
  target: false,
  treeshake: false,
  unbundle: true,
});
