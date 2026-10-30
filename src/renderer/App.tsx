import { useCallback, useEffect, useRef, useState } from "react";
import {
  Plus,
  FolderOpen,
  Command,
  LayoutGrid,
  Network,
  PanelLeftClose,
  ArrowUpRight,
  Terminal,
  GitBranch,
  X,
  Search,
  FileText,
  Square,
  Activity,
} from "lucide-react";
import type {
  Attempt,
  Project,
  Provider,
  Snapshot,
  Task,
  TaskStatus,
  Worktree,
} from "../shared/contracts";
import { TerminalView } from "./TerminalView";
import { ReviewPanel } from "./ReviewPanel";
import { CanvasView } from "./CanvasView";
const initial: Snapshot = {
  projects: [],
  tasks: [],
  attempts: [],
  sessions: [],
  notes: [],
  layouts: [],
  capabilities: [],
};
const columns: { id: TaskStatus; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "in_progress", label: "In progress" },
  { id: "review", label: "In review" },
  { id: "done", label: "Done" },
];
const label = (status: TaskStatus) =>
  columns.find((c) => c.id === status)?.label;

export default function App() {
  const [editorDirty, setEditorDirty] = useState(false);
  const canNavigate = useCallback(
    () => !editorDirty || confirm("Discard unsaved editor changes?"),
    [editorDirty],
  );
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [attention, setAttention] = useState(false);
  const [snapshot, setSnapshot] = useState(initial);
  const [projectId, setProjectId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [attemptId, setAttemptId] = useState("");
  const [view, setView] = useState<"focus" | "board" | "canvas">("focus");
  const [modal, setModal] = useState<
    "task" | "edit-task" | "attempt" | "palette" | null
  >(null);
  const [error, setError] = useState("");
  const [core, setCore] = useState("starting");
  const [query, setQuery] = useState("");
  const [review, setReview] = useState(true);
  const report = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );
  const reload = useCallback(
    () =>
      window.workspace
        .invoke<Snapshot>("snapshot")
        .then((value) => {
          setSnapshot(value);
          setCore("ready");
        })
        .catch(report),
    [report],
  );
  useEffect(() => {
    void reload();
    return window.workspace.subscribe((event) => {
      if (event.type === "snapshot") setSnapshot(event.snapshot);
      if (event.type === "core.status") {
        setCore(event.status);
        if (event.message) setError(event.message);
        if (event.status === "ready") void reload();
      }
    });
  }, [reload]);
  useEffect(() => {
    if (!projectId && snapshot.projects.length)
      setProjectId(snapshot.projects[0]!.id);
  }, [snapshot.projects, projectId]);
  const project = snapshot.projects.find((p) => p.id === projectId);
  const tasks = snapshot.tasks.filter((t) => t.projectId === projectId);
  const task = tasks.find((t) => t.id === taskId);
  const attempts = snapshot.attempts.filter((a) => a.projectId === projectId);
  const taskAttempts = attempts.filter((a) => a.taskId === taskId);
  const attempt =
    taskAttempts.find((a) => a.id === attemptId) || taskAttempts[0];
  const session = snapshot.sessions.find((s) => s.id === attempt?.sessionId);
  const running = attempts.filter((a) => a.status === "running").length;
  const chooseProject = (id: string) => {
    if (!canNavigate()) return;
    setProjectId(id);
    setTaskId("");
    setAttemptId("");
  };
  const chooseTask = (id: string) => {
    if (!canNavigate()) return;
    setTaskId(id);
    setAttemptId("");
    setView("focus");
  };
  const openProject = useCallback(async () => {
    if (!canNavigate()) return;
    try {
      const path = await window.workspace.chooseDirectory();
      if (path) {
        const added = await window.workspace.invoke<Project>("project.add", {
          path,
        });
        setProjectId(added.id);
        setTaskId("");
        await reload();
      }
    } catch (e) {
      report(e);
    }
  }, [reload, report, canNavigate]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setModal((m) => (m === "palette" ? null : "palette"));
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (projectId) setModal("task");
      }
      if (e.key === "Escape") setModal(null);
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [projectId]);
  async function move(t: Task, status: TaskStatus) {
    try {
      await window.workspace.invoke("task.update", {
        taskId: t.id,
        revision: t.revision,
        status,
      });
    } catch (e) {
      report(e);
    }
  }
  async function addNote() {
    if (!canNavigate()) return;
    try {
      await window.workspace.invoke("note.create", {
        projectId,
        title: "Workspace note",
        body: "",
      });
      setView("canvas");
    } catch (e) {
      report(e);
    }
  }
  useEffect(() => {
    if (!editorDirty) return;
    function preventUnsavedClose(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "Unsaved editor changes";
      setError(
        "Save your editor changes or close the editor and discard them before closing this window.",
      );
    }
    window.addEventListener("beforeunload", preventUnsavedClose);
    return () =>
      window.removeEventListener("beforeunload", preventUnsavedClose);
  }, [editorDirty]);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            a<span>·</span>
          </div>
          <div>
            Agent Workspace<small>LOCAL WORKSPACE</small>
          </div>
        </div>
        <button
          className="search-button"
          onClick={() => {
            setQuery("");
            setModal("palette");
          }}
        >
          <Search size={15} />
          <span>Find anything</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="section-heading">
          PROJECTS
          <button
            className="icon-button"
            aria-label="Open repository"
            onClick={() => void openProject()}
          >
            <Plus size={15} />
          </button>
        </div>
        <nav className="projects">
          {snapshot.projects.map((p) => (
            <button
              key={p.id}
              className={p.id === projectId ? "selected" : ""}
              onClick={() => chooseProject(p.id)}
            >
              <FolderOpen size={16} />
              <span>{p.name}</span>
              {p.id === projectId ? <span className="selected-dot" /> : null}
            </button>
          ))}
          {!snapshot.projects.length ? (
            <button onClick={() => void openProject()}>
              <Plus size={15} />
              Open a repository
            </button>
          ) : null}
        </nav>
        <div className="section-heading">
          TASKS <span>{tasks.length}</span>
          {project ? (
            <button
              className="icon-button"
              aria-label="Create task"
              onClick={() => setModal("task")}
            >
              <Plus size={15} />
            </button>
          ) : null}
        </div>
        <div className="task-list">
          {tasks.map((t) => (
            <button
              key={t.id}
              className={"task-link " + (taskId === t.id ? "selected" : "")}
              onClick={() => chooseTask(t.id)}
            >
              <span className={"status-dot " + t.status} />
              <div>
                <span>{t.title}</span>
                <small>
                  {label(t.status)} ·{" "}
                  {attempts.filter((a) => a.taskId === t.id).length} attempts
                </small>
              </div>
            </button>
          ))}
          {project && !tasks.length ? (
            <div className="sidebar-empty">
              Give your agents a clear starting point.
              <button onClick={() => setModal("task")}>
                Create your first task <ArrowUpRight size={12} />
              </button>
            </div>
          ) : null}
        </div>
        <div className="sidebar-bottom">
          <div className="connection">
            <span className={"tiny-dot " + (core === "failed" ? "red" : "")} />
            Local core
            <span>
              {core === "starting" && snapshot.projects.length
                ? "Connected"
                : core === "ready"
                  ? "Connected"
                  : core}
            </span>
          </div>
          <button onClick={() => setModal("palette")}>
            <Command size={14} />
            Keyboard & commands<kbd>⌘ K</kbd>
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <span>/</span>
            <strong>{project?.name || "Welcome"}</strong>
          </div>
          <div className="top-actions">
            <button
              className="live-count"
              onClick={() => setAttention((a) => !a)}
            >
              <Activity size={13} />
              {running} running
            </button>
            <button
              className="icon-button"
              aria-label="Toggle review panel"
              onClick={() => {
                if (canNavigate()) setReview((r) => !r);
              }}
            >
              <PanelLeftClose size={17} />
            </button>
            {project ? (
              <button
                className="primary small"
                onClick={() => setModal("task")}
              >
                <Plus size={14} />
                New task
              </button>
            ) : null}
          </div>
        </header>
        {attention ? (
          <div className="attention-panel">
            <header>
              <strong>Session attention</strong>
              <button
                className="icon-button"
                aria-label="Close session attention"
                onClick={() => setAttention(false)}
              >
                <X size={15} />
              </button>
            </header>
            <p>
              Agent questions and permission requests appear in their terminal.
              Open an attempt to respond directly.
            </p>
            {attempts
              .filter((a) => a.status === "unknown")
              .map((a) => (
                <button
                  key={a.id}
                  onClick={() => {
                    chooseTask(a.taskId);
                    setAttemptId(a.id);
                    setAttention(false);
                  }}
                >
                  Check {a.provider} session · runtime unknown
                </button>
              ))}
            {snapshot.capabilities.map((c) => (
              <div key={c.name}>
                <span
                  className={"tiny-dot " + (c.available ? "" : "neutral")}
                />
                <strong>{c.name}</strong>
                <small>{c.detail}</small>
              </div>
            ))}
          </div>
        ) : null}
        {error ? (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        ) : null}
        {!project ? (
          <div className="welcome">
            <div className="welcome-eyebrow">A LITTLE ROOM TO BUILD</div>
            <h1>
              Good work starts
              <br />
              with a clear workspace.
            </h1>
            <p>
              Bring your repository, your agents, and your next idea.
              <br />
              Keep every attempt close to the work it belongs to.
            </p>
            <button className="primary" onClick={() => void openProject()}>
              <FolderOpen size={17} />
              Open a repository
              <ArrowUpRight size={16} />
            </button>
            <div className="welcome-features">
              <span>
                <Terminal size={16} />
                Persistent terminals
              </span>
              <span>
                <GitBranch size={16} />
                Isolated worktrees
              </span>
              <span>
                <Network size={16} />A canvas for context
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className="workspace-heading">
              <div>
                <div className="eyebrow">PROJECT WORKSPACE</div>
                <h1>{project.name}</h1>
                <p>{project.path}</p>
              </div>
              <div className="view-tabs">
                <button
                  className={view === "focus" ? "active" : ""}
                  onClick={() => setView("focus")}
                >
                  <Terminal size={14} />
                  Focus
                </button>
                <button
                  className={view === "board" ? "active" : ""}
                  onClick={() => {
                    if (canNavigate()) setView("board");
                  }}
                >
                  <LayoutGrid size={14} />
                  Board
                </button>
                <button
                  className={view === "canvas" ? "active" : ""}
                  onClick={() => {
                    if (canNavigate()) setView("canvas");
                  }}
                >
                  <Network size={14} />
                  Canvas
                </button>
              </div>
            </div>
            {view === "board" ? (
              <div className="board">
                {columns.map((column) => (
                  <section
                    className="board-column"
                    key={column.id}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const item = tasks.find(
                        (t) => t.id === e.dataTransfer.getData("text/plain"),
                      );
                      if (item) void move(item, column.id);
                    }}
                  >
                    <header>
                      <span className={"status-dot " + column.id} />
                      <strong>{column.label}</strong>
                      <span>
                        {tasks.filter((t) => t.status === column.id).length}
                      </span>
                    </header>
                    {tasks
                      .filter((t) => t.status === column.id)
                      .map((t) => (
                        <article
                          key={t.id}
                          className="board-card"
                          draggable
                          onDragStart={(e) =>
                            e.dataTransfer.setData("text/plain", t.id)
                          }
                        >
                          <button
                            className="card-title"
                            onClick={() => chooseTask(t.id)}
                          >
                            {t.title}
                          </button>
                          {t.description ? <p>{t.description}</p> : null}
                          <footer>
                            <span>
                              {attempts.filter((a) => a.taskId === t.id).length}{" "}
                              attempts
                            </span>
                            <select
                              aria-label={"Status for " + t.title}
                              value={t.status}
                              onChange={(e) =>
                                void move(t, e.target.value as TaskStatus)
                              }
                            >
                              {columns.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.label}
                                </option>
                              ))}
                            </select>
                          </footer>
                        </article>
                      ))}
                    <button
                      className="board-add"
                      onClick={() => setModal("task")}
                    >
                      <Plus size={13} />
                      Add task
                    </button>
                  </section>
                ))}
              </div>
            ) : null}
            {view === "canvas" ? (
              <div className="canvas-area">
                <div className="canvas-toolbar">
                  <span>Sessions stay alive as you move between views.</span>
                  <button className="secondary" onClick={() => void addNote()}>
                    <FileText size={14} />
                    Add note
                  </button>
                </div>
                <CanvasView
                  key={projectId}
                  projectId={projectId}
                  attempts={attempts}
                  sessions={snapshot.sessions}
                  notes={snapshot.notes.filter(
                    (n) => n.projectId === projectId,
                  )}
                  layout={snapshot.layouts.find(
                    (l) => l.projectId === projectId,
                  )}
                  report={report}
                />
              </div>
            ) : null}
            {view === "focus" ? (
              <div className="focus-layout">
                <section className="focus-main">
                  {task ? (
                    <>
                      <div className="task-heading">
                        <div>
                          <div className="eyebrow">
                            TASK · {label(task.status)}
                          </div>
                          <h2>
                            {task.title}{" "}
                            <button
                              className="edit-task-button"
                              onClick={() => setModal("edit-task")}
                            >
                              Edit
                            </button>
                          </h2>
                          {task.description ? <p>{task.description}</p> : null}
                        </div>
                        <select
                          aria-label="Task workflow status"
                          value={task.status}
                          onChange={(e) =>
                            void move(task, e.target.value as TaskStatus)
                          }
                        >
                          {columns.map((c) => (
                            <option value={c.id} key={c.id}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="attempt-tabs">
                        {taskAttempts.map((a, i) => (
                          <button
                            key={a.id}
                            className={a.id === attempt?.id ? "active" : ""}
                            onClick={() => {
                              if (canNavigate()) setAttemptId(a.id);
                            }}
                          >
                            <span
                              className={
                                "tiny-dot " +
                                (a.status === "running" ? "" : "neutral")
                              }
                            />
                            {a.provider}
                            <span>#{i + 1}</span>
                          </button>
                        ))}
                        <button onClick={() => setModal("attempt")}>
                          <Plus size={14} />
                          New attempt
                        </button>
                      </div>
                      {session ? (
                        <>
                          <div className="terminal-toolbar">
                            <span>
                              <Terminal size={13} />
                              {session.cwd}
                            </span>
                            <div>
                              <span>{session.status}</span>
                              {session.status === "running" && viewerId ? (
                                <>
                                  <button
                                    title="Send interrupt"
                                    onClick={() =>
                                      void window.workspace
                                        .invoke("session.input", {
                                          sessionId: session.id,
                                          generation: session.generation,
                                          viewerId,
                                          data: "\u0003",
                                        })
                                        .catch(report)
                                    }
                                  >
                                    Interrupt
                                  </button>
                                  <button
                                    title="End this terminal process"
                                    onClick={() => {
                                      if (
                                        confirm(
                                          "Terminate this session? The running process will stop.",
                                        )
                                      )
                                        void window.workspace
                                          .invoke("session.terminate", {
                                            sessionId: session.id,
                                            generation: session.generation,
                                            viewerId,
                                          })
                                          .catch(report);
                                    }}
                                  >
                                    <Square size={11} />
                                    End
                                  </button>
                                </>
                              ) : null}
                            </div>
                          </div>
                          <div className="focus-terminal">
                            <TerminalView
                              key={session.id}
                              session={session}
                              onViewer={setViewerId}
                            />
                          </div>
                        </>
                      ) : (
                        <div className="work-empty">
                          <div className="empty-terminal">›_</div>
                          <h2>Make your first attempt.</h2>
                          <p>
                            Run a shell, Claude, or Codex in this task’s working
                            directory.
                            <br />
                            Every attempt keeps its own terminal and history.
                          </p>
                          <button
                            className="primary"
                            onClick={() => setModal("attempt")}
                          >
                            <Plus size={15} />
                            Start an attempt
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="work-empty">
                      <div className="empty-terminal">↗</div>
                      <h2>
                        {tasks.length
                          ? "Choose your next focus."
                          : "What are we building?"}
                      </h2>
                      <p>
                        {tasks.length
                          ? "Select a task from the sidebar, or explore your board."
                          : "Create a task to organize your agents and their attempts."}
                      </p>
                      <button
                        className="primary"
                        onClick={() => setModal("task")}
                      >
                        <Plus size={15} />
                        Create a task
                      </button>
                    </div>
                  )}
                </section>
                {review ? (
                  <ReviewPanel
                    key={projectId + attempt?.worktreePath}
                    project={project}
                    worktreePath={attempt?.worktreePath}
                    report={report}
                    onDirtyChange={setEditorDirty}
                  />
                ) : null}
              </div>
            ) : null}
            <footer className="statusbar">
              <span>
                <span className="tiny-dot" />
                Local execution
              </span>
              <span>
                {snapshot.capabilities
                  .filter((c) => c.available)
                  .map((c) => c.name)
                  .join(" · ") || "Checking capabilities"}
              </span>
              <span>⌘ K commands</span>
            </footer>
          </>
        )}
      </main>
      {modal === "task" || modal === "edit-task" ? (
        <TaskModal
          existing={modal === "edit-task" ? task : undefined}
          projectId={projectId}
          close={() => setModal(null)}
          created={(id) => {
            chooseTask(id);
            setModal(null);
          }}
          report={report}
        />
      ) : null}
      {modal === "attempt" && task ? (
        <AttemptModal
          task={task}
          close={() => setModal(null)}
          created={(a) => {
            setAttemptId(a.id);
            setModal(null);
          }}
          report={report}
        />
      ) : null}
      {modal === "palette" ? (
        <div className="modal-backdrop" onMouseDown={() => setModal(null)}>
          <section
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="palette-search">
              <Search size={18} />
              <input
                autoFocus
                placeholder="Search tasks or run a command…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <kbd>ESC</kbd>
            </div>
            <div className="palette-options">
              {!query || "open repository".includes(query.toLowerCase()) ? (
                <button
                  onClick={() => {
                    setModal(null);
                    void openProject();
                  }}
                >
                  <FolderOpen size={16} />
                  Open repository
                </button>
              ) : null}
              {project &&
              (!query || "new task".includes(query.toLowerCase())) ? (
                <button onClick={() => setModal("task")}>
                  <Plus size={16} />
                  Create task<kbd>⌘ N</kbd>
                </button>
              ) : null}
              {project &&
              (!query || "canvas note".includes(query.toLowerCase())) ? (
                <button
                  onClick={() => {
                    setModal(null);
                    void addNote();
                  }}
                >
                  <FileText size={16} />
                  Add canvas note
                </button>
              ) : null}
              {tasks
                .filter((t) =>
                  t.title.toLowerCase().includes(query.toLowerCase()),
                )
                .map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      chooseTask(t.id);
                      setModal(null);
                    }}
                  >
                    <span className={"status-dot " + t.status} />
                    {t.title}
                    <span className="muted">{label(t.status)}</span>
                  </button>
                ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
function TaskModal({
  existing,
  projectId,
  close,
  created,
  report,
}: {
  existing?: Task;
  projectId: string;
  close: () => void;
  created: (id: string) => void;
  report: (e: unknown) => void;
}) {
  const [title, setTitle] = useState(existing?.title || "");
  const [description, setDescription] = useState(existing?.description || "");
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-title"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const task = await window.workspace.invoke<Task>(
              existing ? "task.update" : "task.create",
              {
                taskId: existing?.id,
                revision: existing?.revision,
                projectId,
                title,
                description,
              },
            );
            created(task.id);
          } catch (e) {
            report(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        <header>
          <div>
            <div className="eyebrow">MAKE ROOM FOR AN IDEA</div>
            <h2 id="task-title">{existing ? "Edit task" : "Create a task"}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label="Close"
          >
            <X size={19} />
          </button>
        </header>
        <label>
          Task name
          <input
            autoFocus
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What do you want to work on?"
          />
        </label>
        <label>
          Description <span className="muted">optional</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add context, constraints, or an intended outcome."
          />
        </label>
        <footer>
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !title.trim()}>
            {busy ? "Saving…" : existing ? "Save task" : "Create task"}
            <ArrowUpRight size={15} />
          </button>
        </footer>
      </form>
    </div>
  );
}
function AttemptModal({
  task,
  close,
  created,
  report,
}: {
  task: Task;
  close: () => void;
  created: (attempt: Attempt) => void;
  report: (e: unknown) => void;
}) {
  const [provider, setProvider] = useState<Provider>("shell");
  const launch = useRef<{
    key: string;
    payload: Record<string, unknown>;
  } | null>(null);
  const createdTree = useRef<string | null>(null);
  const [launchPending, setLaunchPending] = useState(false);
  const [prompt, setPrompt] = useState(
    task.description ? task.title + "\n\n" + task.description : task.title,
  );
  const [trees, setTrees] = useState<Worktree[]>([]);
  const [path, setPath] = useState("");
  const [newTree, setNewTree] = useState(false);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void window.workspace
      .invoke<Worktree[]>("worktree.list", { projectId: task.projectId })
      .then(setTrees)
      .catch(report);
  }, [task.projectId, report]);
  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="attempt-title"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            let worktreePath = createdTree.current || path;
            if (newTree && !createdTree.current && !launch.current) {
              const tree = await window.workspace.invoke<Worktree>(
                "worktree.create",
                { projectId: task.projectId, branch },
              );
              worktreePath = tree.path;
              createdTree.current = tree.path;
            }
            if (!launch.current)
              launch.current = {
                key: crypto.randomUUID(),
                payload: {
                  taskId: task.id,
                  provider,
                  worktreePath: worktreePath || undefined,
                  prompt,
                },
              };
            setLaunchPending(true);
            const result = await window.workspace.invoke<{ attempt: Attempt }>(
              "attempt.start",
              { ...launch.current.payload, idempotencyKey: launch.current.key },
            );
            created(result.attempt);
          } catch (e) {
            report(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        <header>
          <div>
            <div className="eyebrow">A FRESH PERSPECTIVE</div>
            <h2 id="attempt-title">Start an attempt</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={close}
          >
            <X size={19} />
          </button>
        </header>
        <p className="modal-context">{task.title}</p>
        {launchPending ? (
          <p className="form-hint">
            A launch was requested. Retrying checks the same attempt; it does
            not start another process.
          </p>
        ) : null}
        <fieldset disabled={launchPending || busy} className="attempt-fields">
          <label>Run with</label>
          <div className="provider-options">
            {(["shell", "claude", "codex"] as const).map((p) => (
              <button
                className={provider === p ? "selected" : ""}
                type="button"
                key={p}
                onClick={() => setProvider(p)}
              >
                <Terminal size={19} />
                <strong>
                  {p === "shell"
                    ? "Shell"
                    : p === "claude"
                      ? "Claude"
                      : "Codex"}
                </strong>
                <span>
                  {p === "shell" ? "Your local shell" : "Installed CLI"}
                </span>
              </button>
            ))}
          </div>
          {provider !== "shell" ? (
            <label>
              Initial prompt
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe the work for this attempt"
              />
            </label>
          ) : null}
          <label>
            Working directory
            <select
              value={newTree ? "__new" : path}
              onChange={(e) => {
                setNewTree(e.target.value === "__new");
                setPath(e.target.value === "__new" ? "" : e.target.value);
              }}
            >
              <option value="">Main repository</option>
              {trees.map((tree) => (
                <option key={tree.path} value={tree.path}>
                  {tree.branch || tree.path}
                </option>
              ))}
              <option value="__new">Create an isolated worktree…</option>
            </select>
          </label>
          {newTree ? (
            <label>
              New branch
              <input
                required
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="feature/my-task"
              />
            </label>
          ) : null}
        </fieldset>
        <p className="form-hint">
          {provider === "shell"
            ? "The shell starts in the selected working directory."
            : "The CLI uses your existing installation and authentication. The initial prompt is sent once at launch; follow-up input goes through the terminal."}
        </p>
        <footer>
          <button className="secondary" type="button" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy
              ? "Starting…"
              : launchPending
                ? "Check same launch"
                : "Start attempt"}
            <ArrowUpRight size={15} />
          </button>
        </footer>
      </form>
    </div>
  );
}
