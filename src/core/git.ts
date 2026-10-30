import fs from "node:fs";
import path from "node:path";
import { run } from "./process.js";
export interface StatusFile {
  path: string;
  index: string;
  working: string;
  originalPath?: string;
}
export function gitPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    value.split("/").includes("..")
  )
    throw new Error("Invalid Git path");
  return value;
}
export async function gitStatus(root: string) {
  const parts = (
    await run(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      root,
    )
  ).split("\0");
  const files: StatusFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    if (!line) continue;
    const file: StatusFile = {
      index: line[0]!,
      working: line[1]!,
      path: line.slice(3),
    };
    if (/[RC]/.test(file.index) || /[RC]/.test(file.working))
      file.originalPath = parts[++i];
    files.push(file);
  }
  return {
    branch: (await run("git", ["branch", "--show-current"], root)).trim(),
    files,
  };
}
async function expandedPaths(root: string, paths: string[]) {
  const status = await gitStatus(root);
  return [
    ...new Set(
      paths.flatMap((p) => {
        const f = status.files.find((f) => f.path === p);
        return f?.originalPath ? [p, f.originalPath] : [p];
      }),
    ),
  ];
}
export async function gitDiff(
  root: string,
  requested: unknown,
  staged: unknown,
) {
  if (staged !== undefined && typeof staged !== "boolean")
    throw new Error("Invalid staged flag");
  const selected = requested === undefined ? undefined : gitPath(requested);
  if (selected && !staged) {
    const info = (await gitStatus(root)).files.find((f) => f.path === selected);
    if (info?.index === "?") {
      const target = path.resolve(root, selected);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink())
        return {
          diff: `diff --git a/${selected} b/${selected}\nnew file mode 120000\n+${fs.readlinkSync(target)}\n`,
        };
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
        throw new Error(
          "Untracked file exceeds diff limit or is not a regular file",
        );
      try {
        return {
          diff: await run(
            "git",
            [
              "diff",
              "--no-index",
              "--no-ext-diff",
              "--no-textconv",
              "--",
              "/dev/null",
              target,
            ],
            root,
          ),
        };
      } catch (error: any) {
        if (error.code === 1 && typeof error.stdout === "string")
          return { diff: error.stdout };
        throw error;
      }
    }
  }
  const paths = selected ? await expandedPaths(root, [selected]) : [];
  return {
    diff: await run(
      "git",
      [
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        ...(staged ? ["--cached"] : []),
        "--",
        ...paths,
      ],
      root,
    ),
  };
}
export async function gitIndex(
  root: string,
  requested: unknown,
  stage: boolean,
) {
  if (!Array.isArray(requested) || !requested.length)
    throw new Error("Invalid Git paths");
  const paths = requested.map(gitPath);
  const expanded = stage ? paths : await expandedPaths(root, paths);
  if (stage)
    return {
      output: await run(
        "git",
        ["--literal-pathspecs", "add", "--", ...expanded],
        root,
      ),
    };
  let hasHead = true;
  try {
    await run("git", ["rev-parse", "--verify", "HEAD"], root);
  } catch {
    hasHead = false;
  }
  return {
    output: await run(
      "git",
      hasHead
        ? ["--literal-pathspecs", "restore", "--staged", "--", ...expanded]
        : ["--literal-pathspecs", "rm", "--cached", "-r", "--", ...expanded],
      root,
    ),
  };
}
