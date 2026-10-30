import fs from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { DirectoryEntry, DirectoryListing } from "../shared/contracts";

const limit = 2000;
/** Lists one host folder for the owner's in-app navigation. Remote browsers never reach this. */
export async function listDirectory(
  requested?: unknown,
): Promise<DirectoryListing> {
  const home = os.homedir();
  if (
    requested !== undefined &&
    (typeof requested !== "string" ||
      !path.isAbsolute(requested) ||
      requested.includes("\0") ||
      requested.length > 4096)
  )
    throw new Error("Choose a folder from the list");
  let target: string;
  try {
    target = await fs.realpath(requested || home);
    if (!(await fs.stat(target)).isDirectory())
      throw Object.assign(new Error(), { code: "ENOTDIR" });
  } catch (error: any) {
    throw new Error(
      error?.code === "EACCES" || error?.code === "EPERM"
        ? "You don't have permission to open this folder."
        : error?.code === "ENOTDIR"
          ? "That is a file, not a folder."
          : "This folder no longer exists.",
    );
  }
  let names: import("node:fs").Dirent[];
  try {
    names = await fs.readdir(target, { withFileTypes: true });
  } catch (error: any) {
    throw new Error(
      error?.code === "EACCES" || error?.code === "EPERM"
        ? "You don't have permission to see inside this folder."
        : "This folder could not be read.",
    );
  }
  const entries = (
    await Promise.all(
      names.slice(0, limit).map(async (entry): Promise<DirectoryEntry> => {
        const full = path.join(target, entry.name);
        let directory = entry.isDirectory();
        if (entry.isSymbolicLink())
          directory = await fs
            .stat(full)
            .then((s) => s.isDirectory())
            .catch(() => false);
        return {
          name: entry.name,
          path: full,
          type: directory ? "directory" : "file",
          hidden: entry.name.startsWith("."),
          ...(directory && existsSync(path.join(full, ".git"))
            ? { git: true }
            : {}),
        };
      }),
    )
  ).sort(
    (a, b) =>
      Number(b.type === "directory") - Number(a.type === "directory") ||
      a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
  );
  const places = [
    { name: "Home", path: home },
    ...[
      "Desktop",
      "Documents",
      "Developer",
      "Projects",
      "projects",
      "code",
      "Code",
      "src",
      "repos",
    ]
      .map((name) => ({ name, path: path.join(home, name) }))
      .filter((place) => existsSync(place.path)),
    { name: "Computer", path: path.parse(home).root },
  ];
  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    home,
    git: existsSync(path.join(target, ".git")),
    entries,
    truncated: names.length > limit,
    places: places.filter(
      (place, index) =>
        places.findIndex((other) => other.path === place.path) === index,
    ),
  };
}

/**
 * Apps opened from the Dock do not inherit the login shell's PATH, so CLIs
 * installed through nvm, Volta, Bun or a shell profile would look missing.
 * Reads PATH from an interactive login shell, bounded by a timeout.
 */
export function loginShellPath(timeout = 4000): Promise<string> {
  if (process.platform === "win32") return Promise.resolve("");
  const shell =
    process.env.SHELL ||
    (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const marker = "__AGENT_WORKSPACE_PATH__";
  return new Promise((resolve) => {
    try {
      fs.access(shell, constants.X_OK).then(
        () =>
          execFile(
            shell,
            ["-ilc", `printf '%s%s%s' '${marker}' "$PATH" '${marker}'`],
            { timeout, encoding: "utf8", maxBuffer: 1024 * 1024 },
            (_error, stdout) => {
              const match = String(stdout || "").match(
                new RegExp(`${marker}(.*?)${marker}`, "s"),
              );
              resolve(match?.[1]?.trim() || "");
            },
          ).stdin?.end(),
        () => resolve(""),
      );
    } catch {
      resolve("");
    }
  });
}
