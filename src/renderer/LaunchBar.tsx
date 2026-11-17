import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  Folder,
  GitBranch,
  LoaderCircle,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type {
  Capability,
  Project,
  Provider,
  Worktree,
} from "../shared/contracts";
import { capability, providerHint, providerName, providers } from "./sessions";
import { ProviderGlyph } from "./ui";
import { profilesAvailable, useProfiles } from "./ProfilesPanel";

export interface LaunchChoices {
  models: { claude: string; codex: string };
  prompt: string;
  worktreePath: string;
  /** Claude profile for new Claude sessions; "" is the default sign-in. */
  profileId: string;
}
export interface GitSummary {
  branch: string;
  changes: number;
  available: boolean;
  message?: string;
}
const modelsKey = "workspace.launch.models";
export function savedModels(): LaunchChoices["models"] {
  try {
    const value = JSON.parse(localStorage.getItem(modelsKey) || "{}");
    return {
      claude: typeof value.claude === "string" ? value.claude : "",
      codex: typeof value.codex === "string" ? value.codex : "",
    };
  } catch {
    return { claude: "", codex: "" };
  }
}

const lastKey = "workspace.launch.last";
function savedLast(): Provider {
  try {
    const value = localStorage.getItem(lastKey);
    if (value && (providers as string[]).includes(value)) return value as Provider;
  } catch {}
  return "claude";
}

/** Where new sessions start, and the toolbar's New button: one click opens
 *  the provider used last; the menu picks another. */
export function LaunchBar({
  project,
  target,
  onTarget,
  capabilities,
  choices,
  onChoices,
  onLaunch,
  launching,
  disabledReason,
  git,
  onManageProfiles,
  launchers = true,
}: {
  /** False hides the New button (no project to launch into). */
  launchers?: boolean;
  project: Project;
  target: string;
  onTarget: (path: string) => void;
  capabilities: Capability[];
  choices: LaunchChoices;
  onChoices: (choices: LaunchChoices) => void;
  onLaunch: (provider: Provider) => void;
  launching: Provider | null;
  disabledReason: string;
  git: GitSummary | null;
  onManageProfiles?: () => void;
}) {
  const profiles = useProfiles();
  // Profiles are desktop-owner only and local: hidden in browsers and for SSH folders.
  const showProfiles = profilesAvailable() && !project.hostId;
  const profile = showProfiles
    ? profiles.profiles.find((p) => p.id === choices.profileId)
    : undefined;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [last, setLast] = useState<Provider>(savedLast);
  const newMenu = useRef<HTMLDivElement>(null);
  const available = (p: Provider) => {
    const cap = capability(capabilities, p);
    return !cap || cap.available;
  };
  // The remembered provider, unless it is missing on this host.
  const primary = available(last)
    ? last
    : providers.find((p) => available(p)) || last;
  const launchWith = (provider: Provider) => {
    setNewOpen(false);
    setLast(provider);
    try {
      localStorage.setItem(lastKey, provider);
    } catch {}
    onLaunch(provider);
  };
  useEffect(() => {
    if (!newOpen) return;
    newMenu.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
    const close = (event: MouseEvent) => {
      if (!newMenu.current?.contains(event.target as Node)) setNewOpen(false);
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNewOpen(false);
        newMenu.current?.querySelector<HTMLButtonElement>(".new-caret")?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = [
        ...(newMenu.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not(:disabled)',
        ) || []),
      ];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? at + 1 : at - 1;
      items[(next + items.length) % items.length]?.focus();
      event.preventDefault();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", keys);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", keys);
    };
  }, [newOpen]);
  const [trees, setTrees] = useState<Worktree[] | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!optionsOpen) return;
    void window.workspace
      .invoke<Worktree[]>("worktree.list", { projectId: project.id })
      .then(setTrees)
      .catch(() => setTrees([]));
    const close = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) setOptionsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOptionsOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [optionsOpen, project.id]);
  const segments = target ? target.split("/").filter(Boolean) : [];
  const tree = choices.worktreePath
    ? trees?.find((t) => t.path === choices.worktreePath)
    : undefined;
  const where = choices.worktreePath
    ? `worktree ${tree?.branch || choices.worktreePath.split("/").pop()}`
    : [project.name, ...segments].join("/");
  const customised =
    !!choices.prompt.trim() ||
    !!choices.worktreePath ||
    !!choices.models.claude.trim() ||
    !!choices.models.codex.trim() ||
    !!profile;
  const chipFor = (provider: Provider) => {
    const model = provider === "shell" ? "" : choices.models[provider].trim();
    return provider === "claude" && profile
      ? [profile.label, model].filter(Boolean).join(" · ")
      : model;
  };
  return (
    <div className="launch-bar">
      <div className="launch-target">
        <span className="launch-label">Opens in</span>
        <ol
          className="crumbs target-crumbs"
          aria-label="Where new sessions open"
        >
          {choices.worktreePath ? (
            <>
              <li>
                <button
                  aria-current="location"
                  title={`${choices.worktreePath} · change in Launch options`}
                  onClick={() => setOptionsOpen(true)}
                >
                  <GitBranch size={14} />
                  {where}
                </button>
              </li>
              <li>
                <button
                  className="icon-button tiny"
                  aria-label="Open in the main folder instead"
                  title="Use the main folder"
                  onClick={() => onChoices({ ...choices, worktreePath: "" })}
                >
                  <X size={12} />
                </button>
              </li>
            </>
          ) : (
            <>
              <li>
                <button
                  onClick={() => onTarget("")}
                  aria-current={!segments.length ? "location" : undefined}
                  title={project.path}
                >
                  {git?.available ? (
                    <FolderGit2 size={14} />
                  ) : (
                    <Folder size={14} />
                  )}
                  {project.name}
                </button>
              </li>
              {segments.map((segment, index) => (
                <li key={index}>
                  <ChevronRight size={13} aria-hidden="true" />
                  <button
                    onClick={() =>
                      onTarget(segments.slice(0, index + 1).join("/"))
                    }
                    aria-current={
                      index === segments.length - 1 ? "location" : undefined
                    }
                  >
                    {segment}
                  </button>
                </li>
              ))}
              {segments.length ? (
                <li>
                  <button
                    className="icon-button tiny"
                    aria-label="Open at the folder root instead"
                    title="Use the folder root"
                    onClick={() => onTarget("")}
                  >
                    <X size={12} />
                  </button>
                </li>
              ) : null}
            </>
          )}
        </ol>
        {git ? (
          <span
            className={"git-chip" + (git.available ? "" : " muted-chip")}
            title={git.message || ""}
          >
            <GitBranch size={12} />
            {git.available
              ? `${git.branch || "detached"}${git.changes ? ` · ${git.changes} changed` : ""}`
              : "No Git"}
          </span>
        ) : null}
      </div>
      <div
        className="launch-actions"
        role="group"
        aria-label={launchers ? "Open a session" : "Launch options"}
      >
        {launchers ? (
          <div
            className="new-split"
            ref={newMenu}
            role="group"
            aria-label="New session"
          >
            <button
              className={"primary new-main launch-" + primary}
              disabled={!!disabledReason || !!launching}
              title={
                disabledReason ||
                `${providerHint(primary)} in ${where}${chipFor(primary) ? ` · ${chipFor(primary)}` : ""}`
              }
              onClick={() => launchWith(primary)}
            >
              {launching ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <ProviderGlyph provider={primary} />
              )}
              <span className="launch-name">New {providerName(primary)}</span>
            </button>
            <button
              className="primary new-caret"
              aria-label="Choose what to open"
              aria-haspopup="menu"
              aria-expanded={newOpen}
              disabled={!!disabledReason || !!launching}
              onClick={() => setNewOpen((open) => !open)}
            >
              <ChevronDown size={14} />
            </button>
            {newOpen ? (
              <div className="popover menu new-menu" role="menu">
                {providers.map((provider) => {
                  const missing = !available(provider);
                  const chip = chipFor(provider);
                  return (
                    <button
                      key={provider}
                      role="menuitem"
                      className={
                        "launch-item launch-" +
                        provider +
                        (missing ? " is-missing" : "")
                      }
                      title={
                        missing
                          ? `${providerName(provider)} was not found on this host`
                          : `${providerHint(provider)} in ${where}${chip ? ` · ${chip}` : ""}`
                      }
                      onClick={() => launchWith(provider)}
                    >
                      <ProviderGlyph provider={provider} />
                      <span className="launch-name">{providerName(provider)}</span>
                      {missing ? (
                        <small>Not found</small>
                      ) : chip ? (
                        <small>{chip}</small>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="options-anchor" ref={panel}>
          <button
            className={
              "icon-button options-button" + (customised ? " is-set" : "")
            }
            aria-label="Launch options"
            aria-expanded={optionsOpen}
            title="Model, first message and worktree"
            onClick={() => setOptionsOpen((open) => !open)}
          >
            <SlidersHorizontal size={16} />
          </button>
          {optionsOpen ? (
            <div
              className="popover launch-options"
              role="dialog"
              aria-label="Launch options"
            >
              <header>
                <strong>Launch options</strong>
                <span>Optional. One click works without these.</span>
              </header>
              {showProfiles ? (
                <>
                  <label>
                    Claude profile
                    <select
                      aria-label="Claude profile"
                      value={profile ? profile.id : ""}
                      onChange={(event) =>
                        onChoices({ ...choices, profileId: event.target.value })
                      }
                    >
                      <option value="">Default (your usual sign-in)</option>
                      {profiles.profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                          {p.state === "empty" ? " (not set up)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="hint">
                    Used by new Claude sessions only. Resumed conversations and
                    branches keep their own profile.{" "}
                    {onManageProfiles ? (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => {
                          setOptionsOpen(false);
                          onManageProfiles();
                        }}
                      >
                        Manage profiles…
                      </button>
                    ) : null}
                  </p>
                </>
              ) : null}
              <label>
                Claude model
                <input
                  list="claude-models"
                  value={choices.models.claude}
                  placeholder="CLI default"
                  maxLength={150}
                  onChange={(event) =>
                    onChoices({
                      ...choices,
                      models: { ...choices.models, claude: event.target.value },
                    })
                  }
                />
              </label>
              <label>
                Codex model
                <input
                  list="codex-models"
                  value={choices.models.codex}
                  placeholder="CLI default"
                  maxLength={150}
                  onChange={(event) =>
                    onChoices({
                      ...choices,
                      models: { ...choices.models, codex: event.target.value },
                    })
                  }
                />
              </label>
              <datalist id="claude-models">
                <option value="claude-opus-4-6" />
              </datalist>
              <datalist id="codex-models">
                <option value="gpt-6.1-sol" />
              </datalist>
              <p className="hint">
                Blank uses your CLI's configured default. A model your account
                can't use is reported by the CLI in its terminal.
              </p>
              <label>
                First message
                <textarea
                  value={choices.prompt}
                  placeholder="Leave empty to open the agent and type yourself"
                  onChange={(event) =>
                    onChoices({ ...choices, prompt: event.target.value })
                  }
                />
              </label>
              <p className="hint">
                Sent once to the next Claude or Codex session, then cleared.
              </p>
              <label>
                Where
                <select
                  value={choices.worktreePath}
                  disabled={!trees?.length}
                  onChange={(event) =>
                    onChoices({ ...choices, worktreePath: event.target.value })
                  }
                >
                  <option value="">
                    This folder
                    {segments.length ? ` (${segments.join("/")})` : ""}
                  </option>
                  {(trees || [])
                    .filter((t) => t.path !== project.path)
                    .map((t) => (
                      <option key={t.path} value={t.path}>
                        Worktree · {t.branch || t.path}
                      </option>
                    ))}
                </select>
              </label>
              <p className="hint">
                {trees && !trees.length
                  ? "Worktrees need the folder to be a Git repository root."
                  : "Create isolated worktrees from Files → Worktrees."}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
