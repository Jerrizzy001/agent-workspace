/**
 * Desktop owner channel for AI suggestions (`workspace:assist`). Each action is
 * validated here, then forwarded as one owner-only core command. The gateway
 * has no route to these commands, and settings for them change only here,
 * where turning them on requires the owner's acknowledgement of the notice.
 */
import type { Command } from "../shared/contracts";

type Invoke = (command: Command, payload: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
/** The core stops a run after 60 s; leave room for it to report why. */
export const ASSIST_REQUEST_TIMEOUT_MS = 80_000;
export const ASSIST_ACTIONS = [
  "status",
  "configure",
  "previewCommit",
  "stagedHash",
  "suggestCommit",
  "previewName",
  "suggestName",
  "cancel",
] as const;
export const ASSIST_SETTING_KEYS = ["assistProvider", "assistModel"];

function fields(value: unknown, allowed: string[], required: string[] = []) {
  if (value === undefined && !required.length) return {} as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 200_000)
    throw new Error("Invalid AI suggestions request");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !allowed.includes(k))) throw new Error("Invalid AI suggestions request");
  for (const key of required) if (v[key] === undefined) throw new Error("Invalid AI suggestions request");
  return v;
}
const id = (v: unknown) => {
  if (typeof v !== "string" || !v || v.length > 128) throw new Error("Invalid AI suggestions request");
  return v;
};
const optionalPath = (v: unknown) => {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v || v.length > 4096) throw new Error("Invalid AI suggestions request");
  return v;
};
const digest = (v: unknown) => {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) throw new Error("Invalid AI suggestions request");
  return v;
};
function commitScope(v: Record<string, unknown>) {
  const exclude = v.exclude;
  if (exclude !== undefined && (!Array.isArray(exclude) || exclude.length > 1000 || exclude.some((p) => typeof p !== "string" || p.length > 4096)))
    throw new Error("Invalid AI suggestions request");
  const worktreePath = optionalPath(v.worktreePath);
  return {
    projectId: id(v.projectId),
    ...(worktreePath ? { worktreePath } : {}),
    ...(exclude !== undefined ? { exclude } : {}),
  };
}
function include(v: unknown) {
  if (!Array.isArray(v) || !v.length || v.length > 3 || v.some((s) => !["task", "firstMessage", "folder"].includes(s)))
    throw new Error("Invalid AI suggestions request");
  return v;
}

export async function handleAssist(invoke: Invoke, action: unknown, value: unknown): Promise<unknown> {
  switch (action) {
    case "status":
      fields(value, []);
      return invoke("assist.status", {});
    case "configure": {
      const v = fields(value, ["provider", "model", "acknowledged"], ["provider", "model", "acknowledged"]);
      if (!["", "claude", "codex"].includes(v.provider as string) || typeof v.model !== "string" || typeof v.acknowledged !== "boolean")
        throw new Error("Invalid AI suggestions request");
      if (v.provider && v.acknowledged !== true)
        throw new Error("Confirm the notice about sharing selected content with the provider first.");
      const model = (v.model as string).trim();
      // Model first: an invalid model leaves the feature as it was.
      await invoke("settings.write", { key: "assistModel", value: model });
      await invoke("settings.write", { key: "assistProvider", value: v.provider });
      return invoke("assist.status", {});
    }
    case "previewCommit":
      return invoke("assist.preview", { kind: "commit", ...commitScope(fields(value, ["projectId", "worktreePath", "exclude"], ["projectId"])) });
    case "stagedHash": {
      const v = fields(value, ["projectId", "worktreePath"], ["projectId"]);
      return invoke("assist.preview", { kind: "commit", ...commitScope(v), hashOnly: true });
    }
    case "suggestCommit": {
      const v = fields(value, ["projectId", "worktreePath", "exclude", "inputHash", "stagedHash"], ["projectId", "inputHash", "stagedHash"]);
      return invoke(
        "assist.suggest",
        { kind: "commit", ...commitScope(v), inputHash: digest(v.inputHash), stagedHash: digest(v.stagedHash) },
        ASSIST_REQUEST_TIMEOUT_MS,
      );
    }
    case "previewName": {
      const v = fields(value, ["sessionId", "include"], ["sessionId", "include"]);
      return invoke("assist.preview", { kind: "name", sessionId: id(v.sessionId), include: include(v.include) });
    }
    case "suggestName": {
      const v = fields(value, ["sessionId", "include", "inputHash"], ["sessionId", "include", "inputHash"]);
      return invoke(
        "assist.suggest",
        { kind: "name", sessionId: id(v.sessionId), include: include(v.include), inputHash: digest(v.inputHash) },
        ASSIST_REQUEST_TIMEOUT_MS,
      );
    }
    case "cancel":
      fields(value, []);
      await invoke("assist.cancel", {});
      return undefined;
    default:
      throw new Error("Unsupported AI suggestions action");
  }
}
/** The general command channel may not reach suggestions or their settings. */
export function assistOnlyThroughChannel(command: string, payload: Record<string, unknown>) {
  return command.startsWith("assist.") || (command === "settings.write" && ASSIST_SETTING_KEYS.includes(payload.key as string));
}
