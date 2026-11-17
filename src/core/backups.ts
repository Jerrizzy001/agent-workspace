import { backup, type DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Online SQLite backups include WAL data, but never private auth/grant files. */
export function createBackups(db: DatabaseSync, dataDir: string) {
  const directory = path.join(dataDir, "backups");
  let pending: Promise<string> | undefined;
  let closed = false;
  function save(kind: "daily" | "export") {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(
      directory,
      `workspace-${kind}-${stamp}-${crypto.randomUUID().slice(0, 8)}.sqlite`,
    );
    const partial = target + ".partial";
    return (async () => {
      try {
        await backup(db, partial);
        fs.chmodSync(partial, 0o600);
        fs.renameSync(partial, target);
        if (kind === "daily") {
          const old = fs
            .readdirSync(directory)
            .filter((name) =>
              /^workspace-daily-[\dTZ-]+-[a-f0-9]{8}\.sqlite$/.test(name),
            )
            .sort()
            .reverse()
            .slice(7);
          for (const name of old) fs.rmSync(path.join(directory, name));
        }
        return target;
      } finally {
        fs.rmSync(partial, { force: true });
      }
    })();
  }
  async function daily() {
    if (closed) return;
    if (pending) return pending;
    const latest = fs.existsSync(directory)
      ? fs
          .readdirSync(directory)
          .filter((name) =>
            /^workspace-daily-[\dTZ-]+-[a-f0-9]{8}\.sqlite$/.test(name),
          )
          .map((name) => fs.statSync(path.join(directory, name)).mtimeMs)
      : [];
    if (latest.length && Date.now() - Math.max(...latest) < 24 * 60 * 60 * 1000)
      return;
    pending = save("daily").finally(() => {
      pending = undefined;
    });
    return pending;
  }
  const timer = setInterval(
    () =>
      void daily().catch((error) =>
        console.error("Workspace backup failed", error),
      ),
    60 * 60 * 1000,
  );
  timer.unref();
  return {
    daily,
    async export() {
      await pending;
      pending = save("export").finally(() => {
        pending = undefined;
      });
      return { path: await pending };
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await pending;
    },
  };
}
