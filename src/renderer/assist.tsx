/**
 * Opt-in AI suggestions: settings, the commit-message preview/draft dialog and
 * the session-name dialog. Nothing is sent until the owner has turned the
 * feature on, reviewed the exact text in a preview and clicked Generate.
 * Desktop owner window only (remote browsers have no `workspace.assist`).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";
import type {
  AssistCommitPreview,
  AssistNamePreview,
  AssistNameSource,
  AssistNameSuggestion,
  AssistProviderName,
  AssistStatus,
  Session,
} from "../shared/contracts";

export const assistAvailable = () => !!window.workspace?.assist;
const errorText = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    "",
  );

interface AssistState {
  /** "" while off; undefined until read. */
  provider?: AssistProviderName | "";
  settingsOpen: boolean;
  settingsNotice?: string;
}
let state: AssistState = { settingsOpen: false };
const listeners = new Set<() => void>();
function set(patch: Partial<AssistState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
export function useAssist() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
/** Reads only the stored choice; it never runs or probes a provider CLI. */
export async function loadAssistProvider() {
  if (!assistAvailable()) return "";
  const { value } = await window.workspace.invoke<{ value: string }>(
    "settings.read",
    { key: "assistProvider" },
  );
  const provider = value === "claude" || value === "codex" ? value : "";
  set({ provider });
  return provider;
}
export const openAssistSettings = (notice?: string) =>
  set({ settingsOpen: true, settingsNotice: notice });
const closeAssistSettings = () =>
  set({ settingsOpen: false, settingsNotice: undefined });
const providerLabel = (p: string) => (p === "codex" ? "Codex" : "Claude");

/** Owner settings: off by default; turning on requires accepting the notice. */
export function AssistSettings() {
  const { settingsOpen, settingsNotice } = useAssist();
  const [status, setStatus] = useState<AssistStatus | null>(null);
  const [provider, setProvider] = useState<AssistProviderName | "">("");
  const [model, setModel] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!settingsOpen || !window.workspace.assist) return;
    setError("");
    setStatus(null);
    void window.workspace.assist
      .status()
      .then((value) => {
        setStatus(value);
        setProvider(value.provider);
        setModel(value.model);
        setAcknowledged(!!value.provider);
      })
      .catch((e) => setError(errorText(e)));
  }, [settingsOpen]);
  if (!settingsOpen) return null;
  const adapter = status?.adapters.find((a) => a.provider === provider);
  const save = async () => {
    if (!window.workspace.assist) return;
    setBusy(true);
    setError("");
    try {
      const next = await window.workspace.assist.configure({
        provider,
        model,
        acknowledged,
      });
      setStatus(next);
      set({ provider: next.provider });
      closeAssistSettings();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div
      className="modal-backdrop"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        closeAssistSettings();
      }}
    >
      <section
        className="modal assist-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="assist-title"
      >
        <header>
          <div>
            <h2 id="assist-title">AI suggestions</h2>
          </div>
          <button
            className="icon-button"
            onClick={closeAssistSettings}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>
        {settingsNotice ? (
          <p className="assist-callout">{settingsNotice}</p>
        ) : null}
        <p className="muted">
          Drafts commit messages from staged changes, and names for sessions.
          Nothing is sent until you click Generate, after a preview of exactly
          what will go. Drafts are editable; nothing is committed, staged,
          pushed or renamed for you.
        </p>
        <fieldset className="assist-providers" disabled={busy}>
          <legend>Provider</legend>
          {(["", "claude", "codex"] as const).map((value) => {
            const info = status?.adapters.find((a) => a.provider === value);
            const disabled = !!value && (!status || info?.state !== "ready");
            return (
              <label key={value || "off"} className="assist-provider">
                <input
                  type="radio"
                  name="assist-provider"
                  checked={provider === value}
                  disabled={disabled && provider !== value}
                  onChange={() => {
                    setProvider(value);
                    setAcknowledged(false);
                  }}
                />
                <span>
                  <strong>
                    {value ? providerLabel(value) : "Off"}
                    {info ? (
                      <span className={"assist-state state-" + info.state}>
                        {info.state === "ready"
                          ? "Available for suggestions"
                          : info.state === "unverified"
                            ? "Not ready on this CLI version"
                            : "Unavailable"}
                      </span>
                    ) : null}
                  </strong>
                  <span className="muted">
                    {!value
                      ? "No suggestions and no provider calls (default)."
                      : !status
                        ? "Checking the installed CLI…"
                        : info?.state === "ready"
                          ? "Drafts from only the context you preview. Sign-in and model access are checked by the provider when you generate."
                          : "Suggestions are disabled until this CLI can be safely restricted. Use Claude or keep suggestions off."}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        {provider ? (
          <>
            <label>
              Model (optional)
              <input
                value={model}
                placeholder="Blank uses your CLI's default"
                onChange={(e) => setModel(e.target.value)}
                aria-label="AI suggestions model"
              />
            </label>
            <div className="assist-notice" role="note">
              <p>
                When you click Generate, the previewed text (your staged diff,
                or the session context you choose) is sent to{" "}
                {providerLabel(provider)} through your own installed{" "}
                <code>{provider}</code> CLI and its sign-in. It may use your
                plan's usage or API credit and is handled under that provider's
                terms. The CLI runs from an empty private folder with its tools
                turned off, but it is still your provider account.
              </p>
              <label className="assist-check">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                I understand what is sent and that it may use my{" "}
                {providerLabel(provider)} usage.
              </label>
            </div>
          </>
        ) : null}
        {adapter?.state === "unavailable" ? (
          <div className="inline-error">{adapter.detail}</div>
        ) : null}
        {error ? <div className="inline-error">{error}</div> : null}
        <footer>
          <button className="button ghost" onClick={closeAssistSettings}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={
              busy ||
              (!!provider &&
                (!acknowledged || !adapter || adapter.state === "unavailable"))
            }
            onClick={() => void save()}
          >
            Save
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function Backdrop({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return createPortal(
    <div
      className="modal-backdrop"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        onClose();
      }}
    >
      <section
        className="modal assist-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </section>
    </div>,
    document.body,
  );
}
const kilobytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

/** Preview of the staged diff, then one explicit Generate for an editable draft. */
export function AssistCommitDialog({
  scope,
  onDraft,
  onClose,
}: {
  scope: { projectId: string; worktreePath?: string };
  onDraft: (draft: { message: string; stagedHash: string }) => void;
  onClose: () => void;
}) {
  const [exclude, setExclude] = useState<string[]>([]);
  const [preview, setPreview] = useState<AssistCommitPreview | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  useEffect(() => {
    let live = true;
    setError("");
    void window.workspace
      .assist!.previewCommit({ ...scope, exclude })
      .then((value) => live && setPreview(value))
      .catch((e) => {
        if (!live) return;
        setPreview(null);
        setError(errorText(e));
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exclude.join("\0")]);
  const generate = async () => {
    if (!preview) return;
    setRunning(true);
    setError("");
    try {
      const draft = await window.workspace.assist!.suggestCommit({
        ...scope,
        exclude,
        inputHash: preview.inputHash,
        stagedHash: preview.stagedHash,
      });
      onDraft({ message: draft.message, stagedHash: draft.stagedHash });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRunning(false);
    }
  };
  const close = () => {
    if (running) void window.workspace.assist!.cancel();
    onClose();
  };
  return (
    <Backdrop label="Suggest commit message" onClose={close}>
      <header>
        <div>
          <div className="eyebrow">AI suggestion</div>
          <h2>Suggest commit message</h2>
        </div>
        <button className="icon-button" onClick={close} aria-label="Close">
          <X size={16} />
        </button>
      </header>
      {preview ? (
        <>
          <p className="muted">
            {providerLabel(preview.provider)}
            {preview.model
              ? ` · ${preview.model}`
              : " · CLI default model"}{" "}
            will receive the text below ({kilobytes(utf8Bytes(preview.input))},
            staged diff capped at {kilobytes(preview.limit)}). It may use your
            usage. Untick a file to leave it out.
          </p>
          <ul className="assist-files" aria-label="Staged files">
            {preview.files.map((file) => (
              <li key={file.path}>
                <label className="assist-check">
                  <input
                    type="checkbox"
                    checked={file.included}
                    disabled={
                      running || (!file.included && file.reason !== "excluded")
                    }
                    onChange={(e) =>
                      setExclude((list) =>
                        e.target.checked
                          ? list.filter((p) => p !== file.path)
                          : [...list, file.path],
                      )
                    }
                    aria-label={"Include " + file.path}
                  />
                  <code>{file.path}</code>
                  <span className="muted">
                    {file.included
                      ? kilobytes(file.bytes)
                      : file.reason === "binary"
                        ? "binary, not sent"
                        : file.reason === "excluded"
                          ? "left out"
                          : file.reason === "size limit"
                            ? "over the size cap, not sent"
                            : "over the file limit, not sent"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <pre className="assist-input" aria-label="Exact text to be sent">
            {preview.input}
          </pre>
        </>
      ) : !error ? (
        <p className="muted">Reading staged changes…</p>
      ) : null}
      {error ? <div className="inline-error">{error}</div> : null}
      <footer>
        {running ? (
          <button
            className="button ghost"
            onClick={() => void window.workspace.assist!.cancel()}
          >
            Stop
          </button>
        ) : (
          <button className="button ghost" onClick={close}>
            Cancel
          </button>
        )}
        <button
          className="button primary"
          disabled={!preview || running}
          onClick={() => void generate()}
        >
          <Sparkles size={14} />
          {running ? "Generating…" : "Generate draft"}
        </button>
      </footer>
    </Backdrop>
  );
}
function utf8Bytes(text: string) {
  return new TextEncoder().encode(text).length;
}

/** Name suggestion from context the owner ticks; terminal output is never used. */
export function AssistNameDialog({
  session,
  onClose,
  report,
}: {
  session: Session;
  onClose: () => void;
  report: (error: unknown) => void;
}) {
  const [include, setInclude] = useState<AssistNameSource[]>([
    "task",
    "firstMessage",
    "folder",
  ]);
  const [preview, setPreview] = useState<AssistNamePreview | null>(null);
  const [suggestion, setSuggestion] = useState<AssistNameSuggestion | null>(
    null,
  );
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  useEffect(() => {
    let live = true;
    setError("");
    if (!include.length) {
      setPreview(null);
      setError("Choose at least one kind of context to share.");
      return;
    }
    void window.workspace
      .assist!.previewName({ sessionId: session.id, include })
      .then((value) => {
        if (!live) return;
        setPreview(value);
        const available = value.sources.map((s) => s.id);
        if (include.some((id) => !available.includes(id)))
          setInclude(include.filter((id) => available.includes(id)));
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [session.id, include.join(",")]);
  const generate = async () => {
    if (!preview) return;
    setRunning(true);
    setError("");
    try {
      const value = await window.workspace.assist!.suggestName({
        sessionId: session.id,
        include,
        inputHash: preview.inputHash,
      });
      setSuggestion(value);
      setName(value.name);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRunning(false);
    }
  };
  const accept = async () => {
    if (!suggestion) return;
    try {
      await window.workspace.invoke("session.rename", {
        sessionId: suggestion.sessionId,
        generation: suggestion.generation,
        title: name,
        titleRevision: suggestion.titleRevision,
      });
      onClose();
    } catch (e) {
      const text = errorText(e);
      if (/Stale session/.test(text))
        setError(
          "This session was renamed or restarted after the suggestion. Close and suggest again.",
        );
      else report(e);
    }
  };
  const close = () => {
    if (running) void window.workspace.assist!.cancel();
    onClose();
  };
  return (
    <Backdrop label="Suggest session name" onClose={close}>
      <header>
        <div>
          <div className="eyebrow">AI suggestion</div>
          <h2>Suggest a name</h2>
        </div>
        <button className="icon-button" onClick={close} aria-label="Close">
          <X size={16} />
        </button>
      </header>
      <fieldset className="assist-sources" disabled={running}>
        <legend>Context to share</legend>
        {(preview?.sources ?? []).map((source) => (
          <label key={source.id} className="assist-check">
            <input
              type="checkbox"
              checked={include.includes(source.id)}
              onChange={(e) =>
                setInclude((list) =>
                  e.target.checked
                    ? [...list, source.id]
                    : list.filter((id) => id !== source.id),
                )
              }
            />
            {source.label}
          </label>
        ))}
      </fieldset>
      {preview ? (
        <>
          <p className="muted">
            {providerLabel(preview.provider)}
            {preview.model
              ? ` · ${preview.model}`
              : " · CLI default model"}{" "}
            will receive exactly this text. Terminal output is never included.
          </p>
          <pre className="assist-input" aria-label="Exact text to be sent">
            {preview.input}
          </pre>
        </>
      ) : null}
      {suggestion ? (
        <label>
          Suggested name
          <input
            aria-label="Suggested session name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      ) : null}
      {error ? <div className="inline-error">{error}</div> : null}
      <footer>
        {running ? (
          <button
            className="button ghost"
            onClick={() => void window.workspace.assist!.cancel()}
          >
            Stop
          </button>
        ) : (
          <button className="button ghost" onClick={close}>
            Cancel
          </button>
        )}
        <button
          className={suggestion ? "button" : "button primary"}
          disabled={!preview || running || !include.length}
          onClick={() => void generate()}
        >
          <Sparkles size={14} />
          {running ? "Generating…" : suggestion ? "Generate again" : "Generate"}
        </button>
        {suggestion ? (
          <button
            className="button primary"
            disabled={running || !name.trim()}
            onClick={() => void accept()}
          >
            Accept name
          </button>
        ) : null}
      </footer>
    </Backdrop>
  );
}
