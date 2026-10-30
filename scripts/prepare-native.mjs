import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
// node-pty's published macOS spawn helper can arrive without its executable bit.
// Repair only this package's helper on the target host; no Electron ABI tooling.
if (process.platform !== 'win32') {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const relative of ['build/Release/spawn-helper', `prebuilds/${process.platform}-${process.arch}/spawn-helper`]) {
    const file = path.join(root, relative);
    if (existsSync(file)) chmodSync(file, 0o755);
  }
}
