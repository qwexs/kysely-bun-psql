await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  minify: true,
  sourcemap: "linked",
  target: "bun",
  external: ["bun", "kysely"],
  root: "./src",
});
