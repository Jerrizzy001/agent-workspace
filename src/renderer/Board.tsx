import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Plus, X } from "lucide-react";
import type {
  Attempt,
  Capability,
  Provider,
  Session,
  Task,
  TaskStatus,
  Worktree,
} from "../shared/contracts";
import { createId } from "./id";
import { savedModels } from "./LaunchBar";
import { capability, providerName } from "./sessions";
import { ProviderGlyph, StatusBadge } from "./ui";
import { TaskTeamSection, TeamCardMeta, useTeamBoard } from "./TaskTeam";

export const columns: { id: TaskStatus; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "in_progress", label: "In progress" },
  { id: "review", label: "In review" },
  { id: "done", label: "Done" },
];
export const statusLabel = (status: TaskStatus) =>
  columns.find((c) => c.id === status)?.label;

/** Optional planning: tasks, their status, and task-linked attempts. */
export function Board({
  tasks,
  attempts,
  sessions,
  selectedTaskId,
  onSelectTask,
  onNewTask,
  onEditTask,
  onStartAttempt,
  onOpenSession,
  report,
  modeSwitch,
  projectId,
}: {
  modeSwitch?: ReactNode;
  /** The open folder; team metadata (assignee, comments, sync) is shown for its published tasks. */
  projectId?: string;
  tasks: Task[];
  attempts: Attempt[];
  sessions: Session[];
  selectedTaskId: string;
  onSelectTask: (id: string) => void;
  onNewTask: () => void;
  onEditTask: (task: Task) => void;
  onStartAttempt: (task: Task) => void;
  onOpenSession: (sessionId: string) => void;
  report: (error: unknown) => void;
}) {
  async function move(task: Task, status: TaskStatus) {
    try {
      await window.workspace.invoke("task.update", {
        taskId: task.id,
        revision: task.revision,
        status,
      });
    } catch (e) {
      report(e);
    }
  }
  const selected = tasks.find((t) => t.id === selectedTaskId);
  const team = useTeamBoard(projectId, tasks);
  const teamOffline = !!team.status?.connected && !team.status.online;
  const taskAttempts = selected
    ? attempts.filter((a) => a.taskId === selected.id)
    : [];
  return (
    <div className={"board-view" + (selected ? " has-sheet" : "")}>
      <header className="view-head">
        <div>
          <div className="board-title">
            <h2>Board</h2>
            {modeSwitch}
          </div>
          <p>
            Optional planning. Sessions opened from a folder don't need a task;
            use tasks when you want to track work and its attempts.
          </p>
        </div>
        <button className="button primary small" onClick={onNewTask}>
          <Plus size={14} />
          New task
        </button>
      </header>
      <div className="board-body">
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
                <span>{tasks.filter((t) => t.status === column.id).length}</span>
              </header>
              {tasks
                .filter((t) => t.status === column.id)
                .map((t) => {
                  const count = attempts.filter((a) => a.taskId === t.id).length;
                  const live = attempts.filter(
                    (a) => a.taskId === t.id && a.status === "running",
                  ).length;
                  return (
                    <article
                      key={t.id}
                      className={
                        "board-card" + (t.id === selectedTaskId ? " selected" : "")
                      }
                      draggable
                      onDragStart={(e) =>
                        e.dataTransfer.setData("text/plain", t.id)
                      }
                    >
                      <button
                        className="card-title"
                        onClick={() => onSelectTask(t.id)}
                      >
                        {t.title}
                      </button>
                      {t.description ? <p>{t.description}</p> : null}
                      <TeamCardMeta entry={team.entries[t.id]} offline={teamOffline} />
                      <footer>
                        <span>
                          {count} {count === 1 ? "attempt" : "attempts"}
                          {live ? ` · ${live} running` : ""}
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
                  );
                })}
              <button className="board-add" onClick={onNewTask}>
                <Plus size={13} />
                Add task
              </button>
            </section>
          ))}
        </div>
        {selected ? (
          <aside className="task-sheet" aria-label="Task details">
            <header>
              <div>
                <div className="eyebrow">TASK · {statusLabel(selected.status)}</div>
                <h2 className="task-title">{selected.title}</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close task details"
                onClick={() => onSelectTask("")}
              >
                <X size={16} />
              </button>
            </header>
            <div className="task-sheet-actions">
              <button className="button ghost small" onClick={() => onEditTask(selected)}>
                Edit
              </button>
              <select
                aria-label="Task workflow status"
                value={selected.status}
                onChange={(e) => void move(selected, e.target.value as TaskStatus)}
              >
                {columns.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            {selected.description ? (
              <p className="task-description">{selected.description}</p>
            ) : (
              <p className="task-description muted">No description.</p>
            )}
            <h3 className="section-label">Attempts</h3>
            <div className="attempt-list">
              {taskAttempts.map((a, index) => {
                const session = sessions.find((s) => s.id === a.sessionId);
                return (
                  <button
                    key={a.id}
                    className="attempt-row"
                    onClick={() => onOpenSession(a.sessionId)}
                  >
                    <ProviderGlyph provider={a.provider} />
                    <span>
                      {providerName(a.provider)} #{index + 1}
                      {a.model ? <small>{a.model}</small> : null}
                    </span>
                    {session ? <StatusBadge session={session} /> : null}
                  </button>
                );
              })}
              {!taskAttempts.length ? (
                <p className="muted">No attempts yet.</p>
              ) : null}
            </div>
            <button
              className="button primary"
              onClick={() => onStartAttempt(selected)}
            >
              <Plus size={14} />
              Start an attempt
            </button>
            <TaskTeamSection
              task={selected}
              entry={team.entries[selected.id]}
              status={team.status}
              reload={team.reload}
              report={report}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

export function TaskModal({
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
            <div className="eyebrow">Board</div>
            <h2 id="task-title">{existing ? "Edit task" : "Create a task"}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label="Close"
          >
            <X size={18} />
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
          <button type="button" className="button ghost" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !title.trim()}>
            {busy ? "Saving…" : existing ? "Save task" : "Create task"}
            <ArrowUpRight size={15} />
          </button>
        </footer>
      </form>
    </div>
  );
}

/** The advanced flow: launch a provider for a task, optionally in a new worktree. */
export function AttemptModal({
  task,
  capabilities,
  close,
  created,
  report,
}: {
  task: Task;
  capabilities: Capability[];
  close: () => void;
  created: (result: { attempt: Attempt; session: Session }) => void;
  report: (e: unknown) => void;
}) {
  const [provider, setProvider] = useState<Provider>("shell");
  const [models, setModels] = useState(savedModels);
  const model = provider === "claude" ? models.claude : models.codex;
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
      .catch(() => setTrees([]));
  }, [task.projectId]);
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
                key: createId(),
                payload: {
                  taskId: task.id,
                  provider,
                  worktreePath: worktreePath || undefined,
                  // Blank opens the CLI without submitting anything.
                  prompt: provider === "shell" ? undefined : prompt,
                  model:
                    provider !== "shell" && model.trim()
                      ? model.trim()
                      : undefined,
                },
              };
            setLaunchPending(true);
            const result = await window.workspace.invoke<{
              attempt: Attempt;
              session: Session;
            }>("attempt.start", {
              ...launch.current.payload,
              idempotencyKey: launch.current.key,
            });
            created(result);
          } catch (e) {
            report(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        <header>
          <div>
            <div className="eyebrow">Task attempt</div>
            <h2 id="attempt-title">Start an attempt</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={close}
          >
            <X size={18} />
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
            {(["shell", "claude", "codex"] as const).map((p) => {
              const cap = capability(capabilities, p);
              return (
                <button
                  className={provider === p ? "selected" : ""}
                  type="button"
                  key={p}
                  onClick={() => setProvider(p)}
                >
                  <ProviderGlyph provider={p} size={18} />
                  <strong>{providerName(p)}</strong>
                  <span>
                    {p === "shell"
                      ? "Your local shell"
                      : cap && !cap.available
                        ? "Not found"
                        : "Installed CLI"}
                  </span>
                </button>
              );
            })}
          </div>
          {provider !== "shell" ? (
            <label>
              Model <span className="muted">optional</span>
              <input
                value={model}
                list={provider + "-attempt-models"}
                onChange={(e) =>
                  setModels((current) => ({
                    ...current,
                    [provider]: e.target.value,
                  }))
                }
                placeholder="CLI default when blank"
                maxLength={150}
              />
              <datalist id={provider + "-attempt-models"}>
                <option value={provider === "claude" ? "claude-opus-4-6" : "gpt-6.1-sol"} />
              </datalist>
              <span className="form-hint">
                Blank uses your CLI's configured default model.
              </span>
            </label>
          ) : null}
          {provider !== "shell" ? (
            <label>
              First message <span className="muted">optional</span>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Leave empty to open the CLI without sending anything"
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
              <option value="">Main folder</option>
              {trees.map((tree) => (
                <option key={tree.path} value={tree.path}>
                  {tree.branch || tree.path}
                </option>
              ))}
              {trees.length ? (
                <option value="__new">Create an isolated worktree…</option>
              ) : null}
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
            : "Uses your installed CLI and its sign-in. The first message, if any, is sent once at launch."}
        </p>
        <footer>
          <button className="button ghost" type="button" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
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
