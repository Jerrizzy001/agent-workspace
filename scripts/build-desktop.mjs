import { build } from "esbuild";
await build({
  entryPoints: ["src/desktop/main.ts", "src/desktop/preload.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outdir: "dist/desktop",
  outExtension: { ".js": ".cjs" },
  external: ["electron", "node-pty", "ws"],
});
await build({
  entryPoints: ["src/desktop/utility.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/desktop/utility.mjs",
  external: ["electron", "node-pty", "ws"],
});

// The browser host uses Node's native ABI and the same renderer build.
await build({
  entryPoints: ["src/server/headless.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/server/headless.mjs",
  external: ["node-pty", "ws"],
});
