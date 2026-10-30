import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  File,
  Folder,
  RefreshCw,
  Save,
  GitCommitHorizontal,
  Check,
  Minus,
  Sparkles,
} from "lucide-react";
import {
  AssistCommitDialog,
  assistAvailable,
  loadAssistProvider,
  openAssistSettings,
  useAssist,
} from "./assist";
import type {
  FileContent,
  FileEntry,
  GitStatus,
  Project,
  Worktree,
} from "../shared/contracts";
const Editor = lazy(() => import("./editor"));

export interface ReviewSummary {
  branch: string;
  changes: number;
  available: boolean;
  message?: string;
}
type Props = {
  project: Project;
  worktreePath?: string;
  report: (e: unknown) => void;
  onDirtyChange?: (dirty: boolean) => void;
  refreshRevision?: number;
  /** When provided, the Files location is owned by the caller (it sets where sessions open). */
  directory?: string;
  onDirectoryChange?: (directory: string) => void;
  onSummary?: (summary: ReviewSummary) => void;
};
/** Explains why Git review is unavailable for a folder, and what would enable it. */
function gitProblem(reason: unknown) {
  const text = String(reason instanceof Error ? reason.message : reason);
  if (/not a git repository/i.test(text))
    return "This folder isn't a Git repository. Files and terminals work normally; run git init in a Shell here to review changes.";
  if (/repository root/i.test(text))
    return "This folder is inside a Git repository but isn't its root. Open the repository's top folder to review its changes.";
  if (/ENOENT|spawn git/i.test(text))
    return "Git isn't installed on this host. Files and terminals still work.";
  return "Git review is unavailable for this folder: " + text;
}
export function ReviewPanel({
  project,
  worktreePath,
  report,
  onDirtyChange,
  refreshRevision = 0,
  directory: controlledDirectory,
  onDirectoryChange,
  onSummary,
}: Props) {
  const request = useRef(0);
  const refreshTicket = useRef(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<"changes" | "files" | "worktrees">("files");
  const [status, setStatus] = useState<GitStatus>({ branch: "", files: [] });
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [ownDirectory, setOwnDirectory] = useState("");
  const controlled = controlledDirectory !== undefined && !!onDirectoryChange;
  const directory = controlled ? controlledDirectory : ownDirectory;
  const setDirectory = (value: string) =>
    controlled ? onDirectoryChange!(value) : setOwnDirectory(value);
  const summary = useRef(onSummary);
  summary.current = onSummary;
  const [selected, setSelected] = useState<FileContent | null>(null);
  const [content, setContent] = useState("");
  const [diff, setDiff] = useState("");
  const [message, setMessage] = useState("");
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [branch, setBranch] = useState("");
  const scope = { projectId: project.id, worktreePath };
  // AI draft: the staged fingerprint it was generated from, to flag staleness.
  const assist = useAssist();
  const [suggesting, setSuggesting] = useState(false);
  const [draftSource, setDraftSource] = useState<string | null>(null);
  const [draftStale, setDraftStale] = useState(false);
  const draftRef = useRef<string | null>(null);
  draftRef.current = draftSource;
  async function checkDraft() {
    const source = draftRef.current;
    if (!source || !window.workspace.assist) return;
    try {
      const { stagedHash } = await window.workspace.assist.stagedHash(scope);
      if (draftRef.current === source) setDraftStale(stagedHash !== source);
    } catch {
      if (draftRef.current === source) setDraftStale(true);
    }
  }
  async function suggestMessage() {
    const provider =
      assist.provider ?? (await loadAssistProvider().catch(() => ""));
    if (!provider)
      openAssistSettings(
        "AI suggestions are off. Choose a provider to draft commit messages; nothing is sent until you preview and click Generate.",
      );
    else setSuggesting(true);
  }
  useEffect(() => {
    onDirtyChange?.(Boolean(selected && content !== selected.content));
  }, [selected, content, onDirtyChange]);
  useEffect(
    () => () => {
      onDirtyChange?.(false);
      request.current++;
      refreshTicket.current++;
    },
    [onDirtyChange],
  );
  async function refresh() {
    const ticket = ++refreshTicket.current;
    setLoading(true);
    setLoadError("");
    try {
      const [git, entries, trees] = await Promise.allSettled([
        window.workspace.invoke<GitStatus>("git.status", scope),
        window.workspace.invoke<FileEntry[]>("files.list", {
          ...scope,
          path: directory,
        }),
        window.workspace.invoke<Worktree[]>("worktree.list", scope),
      ]);
      if (ticket !== refreshTicket.current) return;
      if (entries.status === "fulfilled") setFiles(entries.value);
      else {
        setFiles([]);
        // A location that vanished returns the Files view to the folder root.
        if (directory && controlled) setDirectory("");
        else report(entries.reason);
      }
      if (git.status === "fulfilled") {
        setStatus(git.value);
        void checkDraft();
        summary.current?.({
          branch: git.value.branch,
          changes: git.value.files.length,
          available: true,
        });
      } else {
        const message = gitProblem(git.reason);
        setStatus({ branch: "", files: [] });
        setLoadError(message);
        summary.current?.({
          branch: "",
          changes: 0,
          available: false,
          message,
        });
      }
      setWorktrees(trees.status === "fulfilled" ? trees.value : []);
    } catch (e) {
      if (ticket === refreshTicket.current) {
        setLoadError(gitProblem(e));
        report(e);
      }
    } finally {
      if (ticket === refreshTicket.current) setLoading(false);
    }
  }
  useEffect(() => {
    request.current++;
    setSelected(null);
    setDiff("");
    if (!controlled) setOwnDirectory("");
    // The caller remounts this panel per folder; a controlled location is kept.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, worktreePath]);
  useEffect(() => {
    void refresh();
  }, [project.id, worktreePath, directory, refreshRevision]);
  function canDiscard() {
    return (
      !selected ||
      content === selected.content ||
      confirm("Discard unsaved changes?")
    );
  }
  async function open(entry: FileEntry) {
    if (!canDiscard()) return;
    const ticket = ++request.current;
    if (entry.type === "directory") {
      setDirectory(entry.path);
      return;
    }
    try {
      const file = await window.workspace.invoke<FileContent>("files.read", {
        ...scope,
        path: entry.path,
      });
      if (ticket !== request.current) return;
      setSelected(file);
      setContent(file.content);
      setDiff("");
    } catch (e) {
      report(e);
    }
  }
  async function showDiff(path: string, staged = false, untracked = false) {
    if (!canDiscard()) return;
    const ticket = ++request.current;
    try {
      if (untracked) {
        await open({ name: path, path, type: "file" });
        return;
      }
      const value = await window.workspace.invoke<string | { diff: string }>(
        "git.diff",
        { ...scope, path, staged },
      );
      if (ticket !== request.current) return;
      setDiff(
        (typeof value === "string" ? value : value.diff) ||
          "No differences in this selection.",
      );
      setSelected(null);
    } catch (e) {
      report(e);
    }
  }
  async function stage(path: string, staged: boolean) {
    try {
      await window.workspace.invoke(staged ? "git.unstage" : "git.stage", {
        ...scope,
        paths: [path],
      });
      await refresh();
    } catch (e) {
      report(e);
    }
  }
  async function commit() {
    try {
      if (draftRef.current && window.workspace.assist) {
        const { stagedHash } = await window.workspace.assist.stagedHash(scope);
        if (stagedHash !== draftRef.current) {
          setDraftStale(true);
          if (
            !confirm(
              "Staged changes changed after the AI draft was generated. Commit with this message anyway?",
            )
          )
            return;
        }
      }
      await window.workspace.invoke("git.commit", { ...scope, message });
      setMessage("");
      setDraftSource(null);
      setDraftStale(false);
      await refresh();
    } catch (e) {
      report(e);
    }
  }
  async function save() {
    if (!selected) return;
    try {
      const saved = await window.workspace.invoke<FileContent>("files.write", {
        ...scope,
        path: selected.path,
        content,
        expectedHash: selected.hash,
      });
      setSelected(saved);
      await refresh();
    } catch (e) {
      report(e);
    }
  }
  return (
    <aside className="review-panel">
      <div className="panel-tabs">
        {(["files", "changes", "worktrees"] as const).map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
          >
            {t === "files" ? "Files" : t === "changes" ? "Changes" : "Worktrees"}
            {t === "changes" && status.files.length ? (
              <span className="tab-count">{status.files.length}</span>
            ) : null}
          </button>
        ))}
        <button
          className="icon-button"
          onClick={() => void refresh()}
          aria-label="Refresh files and git"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="branch-line">
        <span className={"tiny-dot" + (loadError ? " neutral" : "")} />
        {loadError ? "No Git review" : status.branch || "Repository"}
        {loadError ? null : (
          <span className="muted">{status.files.length} changed</span>
        )}
      </div>
      {tab === "changes" ? (
        <>
          <div className="file-list">
            {loading || loadError ? (
              <div className="quiet-empty">
                {loading ? "Reading working tree…" : loadError}
              </div>
            ) : status.files.length === 0 ? (
              <div className="quiet-empty">
                <Check size={20} />
                <p>Working tree is clean</p>
              </div>
            ) : (
              status.files.map((file) => {
                const staged = file.index !== " " && file.index !== "?";
                return (
                  <div className="file-row" key={file.path}>
                    <button
                      onClick={() =>
                        void showDiff(
                          file.path,
                          staged,
                          file.index === "?" || file.working === "?",
                        )
                      }
                    >
                      <span className={"git-code " + (staged ? "staged" : "")}>
                        {staged ? file.index : file.working}
                      </span>
                      <span>{file.path}</span>
                    </button>
                    {staged && file.working !== " " ? (
                      <button
                        className="icon-button"
                        title="View unstaged changes"
                        onClick={() => void showDiff(file.path, false)}
                      >
                        W
                      </button>
                    ) : null}
                    <button
                      className="icon-button"
                      aria-label={(staged ? "Unstage " : "Stage ") + file.path}
                      onClick={() => void stage(file.path, staged)}
                    >
                      {staged ? <Minus size={13} /> : <Check size={13} />}
                    </button>
                  </div>
                );
              })
            )}
          </div>
          <div className="commit-box">
            <textarea
              aria-label="Commit message"
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                if (!e.target.value.trim()) {
                  setDraftSource(null);
                  setDraftStale(false);
                }
              }}
              placeholder="Describe these changes…"
            />
            {draftSource ? (
              <p
                className={"assist-draft-note" + (draftStale ? " stale" : "")}
                role="status"
              >
                {draftStale
                  ? "Staged changes changed after this draft was generated. Review it, or suggest again."
                  : "AI draft from the staged changes. Edit it before committing."}
              </p>
            ) : null}
            {assistAvailable() ? (
              <button
                className="button ghost small assist-suggest"
                disabled={status.files.every(
                  (f) => f.index === " " || f.index === "?",
                )}
                title="Preview the staged diff, then generate an editable draft"
                onClick={() => void suggestMessage()}
              >
                <Sparkles size={13} />
                Suggest message
              </button>
            ) : null}
            <button
              className="secondary full"
              disabled={!message.trim()}
              onClick={() => void commit()}
            >
              <GitCommitHorizontal size={14} />
              Commit staged changes
            </button>
          </div>
        </>
      ) : null}
      {tab === "files" ? (
        <>
          <div className="directory-line">
            <button
              aria-label="Up one folder"
              onClick={() => {
                if (canDiscard())
                  setDirectory(directory.split("/").slice(0, -1).join("/"));
              }}
              disabled={!directory}
            >
              ↑
            </button>
            <span title={directory || "/"}>
              {project.name}
              {directory ? "/" + directory : ""}
            </span>
          </div>
          {controlled && !worktreePath ? (
            <p className="files-hint">
              New sessions open in the folder shown here.
            </p>
          ) : null}
          <div className="file-list">
            {!loading && !files.length ? (
              <div className="quiet-empty">This folder is empty.</div>
            ) : null}
            {files.map((file) => (
              <button
                className="tree-entry"
                key={file.path}
                onClick={() => void open(file)}
              >
                {file.type === "directory" ? (
                  <Folder size={14} />
                ) : (
                  <File size={14} />
                )}
                <span>{file.name}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
      {tab === "worktrees" ? (
        <>
          <div className="worktree-list">
            {worktrees.map((tree) => (
              <div className="worktree-card" key={tree.path}>
                <strong>{tree.branch || "Detached HEAD"}</strong>
                <span>{tree.path}</span>
                <code>{tree.head.slice(0, 8)}</code>
              </div>
            ))}
          </div>
          <form
            className="commit-box"
            onSubmit={(e) => {
              e.preventDefault();
              void window.workspace
                .invoke("worktree.create", { projectId: project.id, branch })
                .then(() => {
                  setBranch("");
                  return refresh();
                })
                .catch(report);
            }}
          >
            <label>
              New worktree branch
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="feature/my-change"
                required
              />
            </label>
            <button className="secondary full">Create worktree</button>
          </form>
        </>
      ) : null}
      {suggesting ? (
        <AssistCommitDialog
          scope={scope}
          onClose={() => setSuggesting(false)}
          onDraft={(draft) => {
            if (
              message.trim() &&
              message !== draft.message &&
              !confirm("Replace the commit message you typed with the AI draft?")
            )
              return;
            setMessage(draft.message);
            setDraftSource(draft.stagedHash);
            setDraftStale(false);
            setSuggesting(false);
          }}
        />
      ) : null}
      {selected || diff ? (
        <div className="editor-overlay">
          <header>
            <span>{selected?.path || "Selected diff"}</span>
            <div>
              {selected ? (
                <button
                  className="secondary"
                  disabled={content === selected.content}
                  onClick={() => void save()}
                >
                  <Save size={14} />
                  Save
                </button>
              ) : null}
              {selected ? (
                <button
                  className="icon-button"
                  aria-label="Reload file from disk"
                  title="Reload file from disk"
                  onClick={() =>
                    void open({
                      name: selected.path,
                      path: selected.path,
                      type: "file",
                    })
                  }
                >
                  <RefreshCw size={15} />
                </button>
              ) : null}
              <button
                className="icon-button"
                onClick={() => {
                  if (canDiscard()) {
                    request.current++;
                    setSelected(null);
                    setDiff("");
                  }
                }}
                aria-label="Close editor"
              >
                ×
              </button>
            </div>
          </header>
          <Suspense fallback={<p className="muted">Loading editor…</p>}>
            <Editor
              key={selected ? selected.path + selected.hash : "diff"}
              content={selected ? content : diff}
              path={selected?.path || "changes.diff"}
              readOnly={!selected}
              onChange={setContent}
            />
          </Suspense>
        </div>
      ) : null}
    </aside>
  );
}
