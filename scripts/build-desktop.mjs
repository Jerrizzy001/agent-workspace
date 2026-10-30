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

// Local dictation worker: model installer and speech-to-text, a separate
// utility process. The sherpa-onnx addon stays a runtime dependency.
await build({
  entryPoints: ["src/desktop/dictation-worker.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/desktop/dictation-worker.mjs",
  external: ["electron", "sherpa-onnx-node"],
  // unbzip2-stream and its helpers are CommonJS and require Node built-ins.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});

// awctl: the agent-control CLI. Node built-ins only; it never opens SQLite.
await build({
  entryPoints: ["src/cli/workspace.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/cli/awctl.mjs",
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
