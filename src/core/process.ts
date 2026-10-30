import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
let active = 0;
const waiting: (() => void)[] = [];
export async function run(
  bin: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  if (active >= 4) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  try {
    return await new Promise((resolve, reject) =>
      execFile(
        bin,
        args,
        { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 15000 },
        (error, stdout, stderr) => {
          if (error) {
            Object.assign(error, { stderr, stdout });
            reject(error);
          } else resolve(stdout);
        },
      ),
    );
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
/** Reads a CLI's own output (for example --help) with no stdin; failures read as empty. */
export function probe(bin: string, args: string[], timeout = 5000) {
  return new Promise<string>((resolve) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      env: { ...process.env, NO_COLOR: "1" },
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      if (output.length < 256 * 1024) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(output));
  });
}
export function executable(name: string) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return "";
}
