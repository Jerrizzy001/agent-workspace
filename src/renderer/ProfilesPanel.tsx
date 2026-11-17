import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import type {
  AccountStatus,
  Project,
  ProfilesState,
  ProfileView,
  Session,
} from "../shared/contracts";
import { createId } from "./id";
import { errorText } from "./sessions";

/** Desktop owner only. Remote browsers have no profiles API. */
export const profilesAvailable = () => !!window.workspace.profiles;

// One shared, refreshable copy of the owner's profiles for labels and pickers.
let current: ProfilesState = { profiles: [], warnings: [] };
const listeners = new Set<() => void>();
export async function refreshProfiles() {
  if (!window.workspace.profiles) return current;
  try {
    current = await window.workspace.profiles.list();
    for (const listener of listeners) listener();
  } catch {
    /* The panel reports problems when it is open. */
  }
  return current;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useProfiles(): ProfilesState {
  return useSyncExternalStore(subscribe, () => current);
}
/** The label shown on a session; "Default" when it has no profile. */
export function profileLabel(
  profileId: string | undefined,
  state: ProfilesState,
) {
  if (!profileId) return undefined;
  return (
    state.profiles.find((p) => p.id === profileId)?.label ?? "removed profile"
  );
}

/** Desktop owner only: named Claude sign-ins kept in private config folders. */
export function ProfilesPanel({
  project,
  onClose,
  onOpened,
}: {
  project?: Project;
  onClose: () => void;
  onOpened: (session: Session) => void;
}) {
  const state = useProfiles();
  const [accounts, setAccounts] = useState<Record<string, AccountStatus>>({});
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [checked, setChecked] = useState<Record<string, ProfileView>>({});
  // One inline confirmation at a time. Keeping the folder is the default.
  const [removing, setRemoving] = useState<{
    id: string;
    deleteData: boolean;
  } | null>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const cancelRemove = (id: string) => {
    setRemoving(null);
    requestAnimationFrame(() => removeButtons.current.get(id)?.focus());
  };
  const api = window.workspace.profiles!;
  useEffect(() => {
    void refreshProfiles();
  }, []);
  const act = async (what: string, work: () => Promise<unknown>) => {
    setBusy(what);
    setError("");
    try {
      await work();
      await refreshProfiles();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const local = project && !project.hostId ? project : undefined;
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <section
        className="modal profiles-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profiles-title"
      >
        <header>
          <div>
            <h2 id="profiles-title">
              Claude profiles
            </h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <p className="profiles-intro">
          A profile is a named Claude configuration folder. It is not proof of a
          separate account. Use Check account to see which identity Claude
          reports, then select the profile in Launch options. Sign-in stays
          inside Claude; this app never changes your global account.
        </p>
        <details className="profiles-support">
          <summary>Which accounts can be separated?</summary>
          <p>
            Claude Code documents separate configuration folders for
            subscription accounts and API-key setups. Two Console (API billing)
            sign-ins without API keys are not supported as separate profiles,
            and some credential stores (for example the macOS Keychain) are
            shared by every folder. Confirm the account in each profile's
            terminal (Claude's <code>/status</code>) before relying on the
            separation.
          </p>
        </details>
        {state.warnings.map((w) => (
          <p key={w} className="profiles-warning" role="note">
            <TriangleAlert size={14} aria-hidden="true" /> {w}
          </p>
        ))}
        {error ? (
          <p className="profiles-error" role="alert">
            {error}
          </p>
        ) : null}
        <ul className="profile-list" aria-label="Profiles">
          <li className="profile-row is-default">
            <div className="profile-name">
              <strong>Default</strong>
              <small>
                Your usual Claude configuration · account{" "}
                {accounts.default
                  ? accounts.default.loggedIn === null
                    ? "unknown"
                    : accounts.default.loggedIn
                      ? "signed in"
                      : "signed out"
                  : "not checked"}
              </small>
              {accounts.default ? (
                <span role="status">
                  {accounts.default.email || ""} · {accounts.default.detail}
                </span>
              ) : null}
            </div>
            <div className="profile-actions">
              <button
                className="button small"
                disabled={!!busy}
                onClick={() =>
                  void act("account:default", async () => {
                    const account = await api.account({});
                    setAccounts((a) => ({ ...a, default: account }));
                  })
                }
              >
                Check default account
              </button>
            </div>
          </li>
          {state.profiles.map((p) => {
            const view = checked[p.id] ?? p;
            return (
              <li key={p.id} className="profile-row">
                <div className="profile-name">
                  <strong>{p.label}</strong>
                  <small>
                    {accounts[p.id]?.email || "Account identity not verified"}
                  </small>
                  {accounts[p.id] ? (
                    <span role="status">{accounts[p.id].detail}</span>
                  ) : null}
                  <details>
                    <summary>Configuration folder</summary>
                    <small>{view.location}</small>
                  </details>
                  <span className={"profile-state state-" + view.state}>
                    {view.state === "ready" ? (
                      <CheckCircle2 size={12} />
                    ) : view.state === "problem" ? (
                      <TriangleAlert size={12} />
                    ) : null}
                    {view.detail}
                    {p.openSessions
                      ? ` · ${p.openSessions} open session${p.openSessions === 1 ? "" : "s"}`
                      : ""}
                  </span>
                </div>
                <div className="profile-actions">
                  <button
                    className="button small"
                    disabled={!!busy}
                    onClick={() =>
                      void act("account:" + p.id, async () => {
                        const account = await api.account({ profileId: p.id });
                        setAccounts((a) => ({ ...a, [p.id]: account }));
                      })
                    }
                  >
                    Check account
                  </button>
                  <button
                    className="button small"
                    disabled={!!busy || !local}
                    title={
                      local
                        ? `Open Claude with this profile in ${local.name} to sign in`
                        : "Open a folder on this computer first"
                    }
                    onClick={() =>
                      void act("setup:" + p.id, async () => {
                        const result = await api.setup({
                          profileId: p.id,
                          projectId: local!.id,
                          idempotencyKey: createId(),
                        });
                        onOpened(result.session);
                        onClose();
                      })
                    }
                  >
                    {busy === "setup:" + p.id ? (
                      <LoaderCircle size={13} className="spin" />
                    ) : (
                      <Terminal size={13} />
                    )}
                    Set up
                  </button>
                  <button
                    className="button ghost small"
                    disabled={!!busy}
                    onClick={() =>
                      void act("check:" + p.id, async () => {
                        const view = await api.check({ profileId: p.id });
                        setChecked((c) => ({ ...c, [p.id]: view }));
                      })
                    }
                  >
                    <RefreshCw size={12} /> Check folder
                  </button>
                  <button
                    ref={(el) => {
                      if (el) removeButtons.current.set(p.id, el);
                      else removeButtons.current.delete(p.id);
                    }}
                    className="button ghost small danger-text"
                    disabled={!!busy || p.openSessions > 0}
                    aria-expanded={removing?.id === p.id}
                    title={
                      p.openSessions
                        ? "End the sessions using this profile first"
                        : "Remove this profile"
                    }
                    onClick={() =>
                      removing?.id === p.id
                        ? cancelRemove(p.id)
                        : setRemoving({ id: p.id, deleteData: false })
                    }
                  >
                    <Trash2 size={12} /> Remove
                  </button>
                </div>
                {removing?.id === p.id ? (
                  <div
                    className="profile-remove"
                    role="group"
                    aria-label={`Remove ${p.label}`}
                    onKeyDown={(e) => {
                      if (e.key !== "Escape") return;
                      e.preventDefault();
                      e.stopPropagation();
                      cancelRemove(p.id);
                    }}
                  >
                    <p>
                      Remove the profile “{p.label}”? Ended sessions that used
                      it can no longer be resumed.
                    </p>
                    <label className="profile-remove-data">
                      <input
                        type="checkbox"
                        checked={removing.deleteData}
                        onChange={(e) =>
                          setRemoving({
                            id: p.id,
                            deleteData: e.target.checked,
                          })
                        }
                      />
                      <span>
                        Also delete its folder, including the Claude sign-in
                        stored there. This can’t be undone.
                        <small>{p.location}</small>
                      </span>
                    </label>
                    <div className="profile-remove-actions">
                      <button
                        className="button small"
                        autoFocus
                        onClick={() => cancelRemove(p.id)}
                      >
                        Cancel
                      </button>
                      <button
                        className="button danger small"
                        disabled={!!busy}
                        onClick={() => {
                          const { deleteData } = removing;
                          setRemoving(null);
                          void act("remove:" + p.id, async () => {
                            const result = await api.remove({
                              profileId: p.id,
                              deleteData,
                            });
                            if (result.keptData)
                              setError(
                                `Removed. Its folder was kept: ${result.keptData}`,
                              );
                          });
                        }}
                      >
                        <Trash2 size={12} />
                        {removing.deleteData
                          ? "Remove and delete folder"
                          : "Remove profile"}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        <form
          className="profile-add"
          onSubmit={(e) => {
            e.preventDefault();
            void act("create", async () => {
              await api.create({ label });
              setLabel("");
            });
          }}
        >
          <label>
            New profile
            <input
              value={label}
              maxLength={40}
              placeholder="Work, Personal…"
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <button
            className="button primary small"
            disabled={!label.trim() || !!busy}
          >
            <Plus size={13} /> Add profile
          </button>
        </form>
        <p className="profiles-foot muted">
          After adding a profile, click <strong>Set up</strong>: Claude opens in
          a terminal using that profile's folder, and you sign in there with
          Claude's own prompts.
        </p>
      </section>
    </div>,
    document.body,
  );
}
