/**
 * Claude profiles (roadmap section 3): named, owner-managed private config
 * folders. A session launched with a profile gets `CLAUDE_CONFIG_DIR=<folder>`
 * in its own tmux session environment only; HOME, the CLI's global files, the
 * tmux server's global environment and every other session are untouched. The
 * default (no profile) keeps whatever the app inherited.
 *
 * The app never signs in, reads tokens, parses credentials or runs a logout.
 * "Set up" opens the unmodified CLI in a terminal with the profile's folder;
 * the owner signs in there with the CLI's own flow.
 */
import { execFile } from "node:child_process";
import { executable } from "./process.js";
import type { AccountStatus } from "../shared/contracts.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type {
  ProfileView,
  ProfilesState,
  Session,
} from "../shared/contracts.js";

export interface ProfileRecord {
  id: string;
  provider: "claude";
  label: string;
  /** Folder name under `<dataDir>/profiles`; a reference, never a credential. */
  folder: string;
  createdAt: string;
}
export const MAX_PROFILES = 16;
const PROFILE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isProfileId = (v: unknown): v is string =>
  typeof v === "string" && PROFILE_ID.test(v);

/** Plain one-line label, 1-40 characters. */
export function profileLabelText(value: unknown) {
  if (typeof value !== "string" || value.length > 400)
    throw new Error("Invalid profile name");
  const label = value
    .replace(/[\p{Cc}\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!label) throw new Error("Name the profile, for example Work or Personal");
  if ([...label].length > 40)
    throw new Error("Profile names are at most 40 characters");
  if (/^default\b/i.test(label))
    throw new Error(
      '"Default" is the name of your usual sign-in; choose another name',
    );
  return label;
}

/**
 * Environment variables that make the CLI use one account whatever the config
 * folder says. Present in the app's environment, they defeat profiles.
 */
const OVERRIDING_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

export function createProfiles(options: {
  dataDir: string;
  list(kind: string): any[];
  put(kind: string, value: any): void;
  remove(kind: string, id: string): void;
  sessions(): Session[];
}) {
  const root = path.join(options.dataDir, "profiles");
  function privateDir(dir: string, create: boolean) {
    if (create) fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("A profile folder is not a private folder");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid())
      throw new Error("A profile folder belongs to another user");
    if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
    return dir;
  }
  function ensureRoot() {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 });
    privateDir(root, false);
  }
  const records = () => options.list("providerProfiles") as ProfileRecord[];
  function record(id: unknown): ProfileRecord {
    if (!isProfileId(id)) throw new Error("Invalid profile");
    const found = records().find((p) => p.id === id);
    if (!found) throw new Error("That profile was removed");
    return found;
  }
  /** The profile's folder, re-checked on every use: inside the root, private, ours. */
  function folder(profile: ProfileRecord) {
    if (!/^[0-9a-f]{32}$/.test(profile.folder))
      throw new Error("Invalid profile folder");
    ensureRoot();
    const dir = path.join(root, profile.folder);
    privateDir(dir, false);
    if (
      fs.realpathSync(dir) !== path.join(fs.realpathSync(root), profile.folder)
    )
      throw new Error("A profile folder is not a private folder");
    return dir;
  }
  const open = (profileId: string) =>
    options
      .sessions()
      .filter((s) => s.profileId === profileId && s.status !== "exited").length;
  function warnings() {
    const out: string[] = [];
    const set = OVERRIDING_ENV.filter((name) => process.env[name]);
    if (set.length)
      out.push(
        `${set.join(", ")} ${set.length === 1 ? "is" : "are"} set in this app's environment. Claude uses ${set.length === 1 ? "it" : "them"} in every session, whatever profile you pick, so profiles do not separate accounts here.`,
      );
    if (process.platform === "darwin")
      out.push(
        "On macOS, Claude may keep sign-in credentials in the login Keychain rather than in the profile folder. Check each profile's account in its terminal before relying on the separation.",
      );
    if (process.platform === "win32")
      out.push("Profiles have not been checked on Windows.");
    return out;
  }
  function view(profile: ProfileRecord): ProfileView {
    let state: ProfileView["state"] = "empty";
    let detail =
      "Not set up yet. Click Set up and sign in with Claude's own prompts.";
    let location = path.join(root, profile.folder);
    try {
      location = folder(profile);
      // Names only, bounded: the app never opens or parses the CLI's files.
      const entries = fs.readdirSync(location).slice(0, 1000);
      if (entries.length) {
        state = "ready";
        detail =
          "Claude has stored its own settings here. Claude checks the sign-in itself when a session starts.";
      }
    } catch (error) {
      state = "problem";
      detail =
        error instanceof Error
          ? error.message
          : "The profile folder cannot be used";
    }
    return {
      id: profile.id,
      provider: "claude",
      label: profile.label,
      createdAt: profile.createdAt,
      location,
      openSessions: open(profile.id),
      state,
      detail,
    };
  }
  function state(): ProfilesState {
    return { profiles: records().map(view), warnings: warnings() };
  }
  const fields = (payload: unknown, allowed: string[]) => {
    if (payload === undefined) payload = {};
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("Invalid profile request");
    const v = payload as Record<string, unknown>;
    if (Object.keys(v).some((k) => !allowed.includes(k)))
      throw new Error("Unexpected profile field");
    return v;
  };
  return {
    fields,
    state,
    view,
    record,
    /** CLAUDE_CONFIG_DIR for a launch with this profile (validated now). */
    launchDir(profileId: unknown) {
      return folder(record(profileId));
    },
    /** The profile's approved transcript storage root, or undefined when absent. */
    storageRoot(profileId: string | undefined) {
      const base = profileId
        ? folder(record(profileId))
        : process.env.CLAUDE_CONFIG_DIR &&
            path.isAbsolute(process.env.CLAUDE_CONFIG_DIR)
          ? process.env.CLAUDE_CONFIG_DIR
          : path.join(os.homedir(), ".claude");
      return path.join(base, "projects");
    },
    create(payload: unknown) {
      const v = fields(payload, ["label"]);
      const label = profileLabelText(v.label);
      const existing = records();
      if (existing.length >= MAX_PROFILES)
        throw new Error(`At most ${MAX_PROFILES} profiles`);
      if (existing.some((p) => p.label.toLowerCase() === label.toLowerCase()))
        throw new Error("A profile with that name already exists");
      ensureRoot();
      const profile: ProfileRecord = {
        id: crypto.randomUUID(),
        provider: "claude",
        label,
        folder: crypto.randomBytes(16).toString("hex"),
        createdAt: new Date().toISOString(),
      };
      privateDir(path.join(root, profile.folder), true);
      try {
        options.put("providerProfiles", profile);
      } catch (error) {
        fs.rmSync(path.join(root, profile.folder), {
          recursive: true,
          force: true,
        });
        throw error;
      }
      return state();
    },
    async account(payload: unknown): Promise<AccountStatus> {
      const v = fields(payload, ["profileId"]);
      const env = {
        ...process.env,
        NO_COLOR: "1",
        ...(v.profileId !== undefined
          ? { CLAUDE_CONFIG_DIR: folder(record(v.profileId)) }
          : {}),
      };
      const checkedAt = new Date().toISOString();
      const bin = executable("claude");
      if (!bin)
        return {
          loggedIn: null,
          checkedAt,
          detail: "Claude CLI is not installed.",
        };
      const read = (args: string[]) =>
        new Promise<string>((resolve) =>
          execFile(
            bin,
            args,
            { env, encoding: "utf8", timeout: 8000, maxBuffer: 65536 },
            (_error, stdout) => resolve(stdout || ""),
          ),
        );
      const help = await read(["auth", "status", "--help"]);
      if (!/--json\b/.test(help))
        return {
          loggedIn: null,
          checkedAt,
          detail:
            "This CLI cannot report account identity. Check /status in the terminal.",
        };
      try {
        const value = JSON.parse(await read(["auth", "status", "--json"]));
        if (typeof value.loggedIn !== "boolean")
          throw new Error("Unsupported response");
        const clean = (v: unknown) =>
          typeof v === "string"
            ? v
                .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, "")
                .slice(0, 200)
            : undefined;
        // Allowlist identity fields only. Never return raw CLI output, tokens,
        // config paths or other provider data; never persist this result.
        return {
          loggedIn: value.loggedIn,
          email: clean(value.email),
          method: clean(value.authMethod),
          checkedAt,
          detail: value.loggedIn
            ? "Signed in according to this CLI. Model access is checked when you run a request."
            : "Not signed in. Open Claude and follow its sign-in prompts.",
        };
      } catch {
        return {
          loggedIn: null,
          checkedAt,
          detail:
            "Account status could not be verified. No sign-in settings were changed.",
        };
      }
    },
    check(payload: unknown) {
      const v = fields(payload, ["profileId"]);
      return view(record(v.profileId));
    },
    /**
     * Removes the profile from the list. Refused while any session using it is
     * running or unknown. Its folder (the CLI's own data, including any stored
     * sign-in) is deleted only when the owner asks; no logout is ever run.
     */
    remove(payload: unknown, launching: () => boolean) {
      const v = fields(payload, ["profileId", "deleteData"]);
      if (typeof v.deleteData !== "boolean")
        throw new Error("Choose whether to delete the profile's data");
      const profile = record(v.profileId);
      const using = options
        .sessions()
        .filter((s) => s.profileId === profile.id && s.status !== "exited");
      if (using.length || launching())
        throw new Error(
          `End the ${using.length || "launching"} session${using.length === 1 ? "" : "s"} using "${profile.label}" first (sessions in an unknown state count too).`,
        );
      const dir = path.join(root, profile.folder);
      options.remove("providerProfiles", profile.id);
      if (v.deleteData) {
        try {
          folder(profile);
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* A folder that is not ours is never deleted. */
        }
        return state();
      }
      return { ...state(), ...(fs.existsSync(dir) ? { keptData: dir } : {}) };
    },
  };
}
export type Profiles = ReturnType<typeof createProfiles>;
