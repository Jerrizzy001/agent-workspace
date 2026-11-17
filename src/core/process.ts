import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
type Lane = { active: number; waiting: (() => void)[] };
const lanes = new Map<string, Lane>();
export interface RunOptions {
  lane?: string;
  timeout?: number;
  maxBuffer?: number;
}
async function queued<T>(name: string, operation: () => Promise<T>) {
  let lane = lanes.get(name);
  if (!lane) {
    lane = { active: 0, waiting: [] };
    lanes.set(name, lane);
  }
  if (lane.active >= 4)
    await new Promise<void>((resolve) => lane!.waiting.push(resolve));
  else lane.active++;
  try {
    return await operation();
  } finally {
    const next = lane.waiting.shift();
    if (next) next();
    else lane.active--;
  }
}
export async function run(
  bin: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  options: RunOptions = {},
): Promise<string> {
  return queued(
    options.lane ?? (path.basename(bin) === "git" ? "git" : "tools"),
    () =>
      new Promise((resolve, reject) =>
        execFile(
          bin,
          args,
          {
            cwd,
            env,
            encoding: "utf8",
            maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
            timeout: options.timeout ?? 15000,
          },
          (error, stdout, stderr) => {
            if (error) {
              if (error.killed)
                error.message =
                  "Operation timed out; outcome unknown. Inspect the repository before retrying. " +
                  error.message;
              Object.assign(error, { stderr, stdout });
              reject(error);
            } else resolve(stdout);
          },
        ),
      ),
  );
}
/** Stream large status output; no execFile buffer, bounded retained diagnostics. */
export async function runStream(
  bin: string,
  args: string[],
  cwd: string,
  consume: (chunk: Buffer) => void,
) {
  return queued(
    "git",
    () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(bin, args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "",
          failure: unknown;
        const timer = setTimeout(() => {
          failure = new Error(
            "Git status timed out. Try again after the repository settles.",
          );
          child.kill();
        }, 60_000);
        child.stdout.on("data", (chunk: Buffer) => {
          try {
            if (!failure) consume(chunk);
          } catch (error) {
            failure = error;
            child.kill();
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < 8192) stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (failure) reject(failure);
          else if (code !== 0)
            reject(new Error(stderr || `Git exited with ${code}`));
          else resolve();
        });
      }),
  );
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

/**
 * Apps started from Finder or the Dock get no locale, and without a UTF-8 one
 * tmux turns every non-ASCII character into "_" and shells inherit "C". Fill
 * in a UTF-8 default only when nothing was chosen.
 */
export function ensureUtf8Locale(env: NodeJS.ProcessEnv = process.env) {
  if (!env.LC_ALL && !env.LC_CTYPE && !env.LANG)
    env.LANG = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}
