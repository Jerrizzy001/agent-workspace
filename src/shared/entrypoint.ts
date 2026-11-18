import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Node canonicalizes import.meta.url, but argv may still use /var or a symlink. */
export function isDirectEntry(url: string, entry = process.argv[1]): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}
