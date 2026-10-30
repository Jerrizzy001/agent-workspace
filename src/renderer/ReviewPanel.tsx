import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  File,
  Folder,
  RefreshCw,
  Save,
  GitCommitHorizontal,
  Check,
  Minus,
} from "lucide-react";
import type {
  FileContent,
  FileEntry,
  GitStatus,
  Project,
  Worktree,
} from "../shared/contracts";
const Editor = lazy(() => import("./editor"));

type Props = {
  project: Project;
  worktreePath?: string;
  report: (e: unknown) => void;
  onDirtyChange?: (dirty: boolean) => void;
  refreshRevision?: number;
};
export function ReviewPanel({
  project,
  worktreePath,
  report,
  onDirtyChange,
  refreshRevision = 0,
}: Props) {
  const request = useRef(0);
  const refreshTicket = useRef(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [tab, setTab] = useState<"changes" | "files" | "worktrees">("changes");
  const [status, setStatus] = useState<GitStatus>({ branch: "", files: [] });
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [directory, setDirectory] = useState("");
  const [selected, setSelected] = useState<FileContent | null>(null);
  const [content, setContent] = useState("");
  const [diff, setDiff] = useState("");
  const [message, setMessage] = useState("");
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [branch, setBranch] = useState("");
  const scope = { projectId: project.id, worktreePath };
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
    setLoadError(false);
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
        report(entries.reason);
      }
      if (git.status === "fulfilled") setStatus(git.value);
      else {
        setStatus({ branch: "Git unavailable", files: [] });
        setLoadError(true);
      }
      setWorktrees(trees.status === "fulfilled" ? trees.value : []);
    } catch (e) {
      if (ticket === refreshTicket.current) {
        setLoadError(true);
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
    setDirectory("");
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
      await window.workspace.invoke("git.commit", { ...scope, message });
      setMessage("");
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
        {(["changes", "files", "worktrees"] as const).map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
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
        <span className="tiny-dot" />
        {status.branch || "Repository"}
        <span className="muted">{status.files.length} changes</span>
      </div>
      {tab === "changes" ? (
        <>
          <div className="file-list">
            {loading || loadError ? (
              <div className="quiet-empty">
                {loading
                  ? "Reading working tree…"
                  : "Git features are unavailable for this folder. Files and shell sessions remain available."}
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
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Describe these changes…"
            />
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
              onClick={() =>
                setDirectory(directory.split("/").slice(0, -1).join("/"))
              }
              disabled={!directory}
            >
              ↑
            </button>
            <span>{directory || "/"}</span>
          </div>
          <div className="file-list">
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
