import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  Ellipsis,
  History,
  MoveRight,
  Pencil,
  Play,
  Plus,
  X,
} from "lucide-react";
import type {
  BoardLanes,
  Capability,
  Project,
  Provider,
  Session,
} from "../shared/contracts";
import { LANE_NAME_LIMIT, MAX_LANES, laneOf, lanesFor } from "../shared/board";
import { SessionView } from "./SessionView";
import {
  capability,
  providerName,
  providers,
  sessionLocation,
  sessionState,
} from "./sessions";
import { ProviderGlyph, StatusBadge } from "./ui";

/** Ended cards beyond this many per lane wait behind "Show more". */
const ENDED_VISIBLE = 20;
const DRAG_TYPE = "application/x-workspace-session";

const lastActive = (s: Session) =>
  typeof s.activityAt === "number" ? s.activityAt : Date.parse(s.createdAt);
function ago(at: number, now: number) {
  const seconds = Math.max(0, (now - at) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
/** Claude conversations that ended cleanly can continue; others start fresh. */
const canResume = (s: Session) =>
  s.status === "exited" &&
  !s.exitCode &&
  s.provider === "claude" &&
  !!s.conversationId;

/**
 * The folder's live sessions as cards in owner-named lanes. Moving a card only
 * changes its placement record; it never restarts, detaches or types into
 * the process.
 */
export function SessionBoard({
  project,
  sessions,
  boards,
  capabilities,
  disabledReason,
  launching,
  titleOf,
  onLaunch,
  onResume,
  onRestart,
  onEnded,
  report,
  modeSwitch,
}: {
  project: Project;
  sessions: Session[];
  boards: BoardLanes[];
  capabilities: Capability[];
  disabledReason: string;
  launching: Provider | null;
  titleOf: (s: Session) => string;
  onLaunch: (provider: Provider) => Promise<Session | undefined>;
  onResume: (s: Session) => Promise<Session | undefined>;
  onRestart: (s: Session) => Promise<Session | undefined>;
  onEnded: (s: Session) => void;
  report: (error: unknown) => void;
  modeSwitch: ReactNode;
}) {
  const board = lanesFor(boards, project.id);
  const lanes = board.lanes;
  const [openId, setOpenId] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dropLane, setDropLane] = useState("");
  const [adding, setAdding] = useState(false);
  const [newLane, setNewLane] = useState("");
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const byLane = useMemo(() => {
    const groups = new Map<string, Session[]>(lanes.map((l) => [l.id, []]));
    for (const s of sessions) groups.get(laneOf(s, lanes) || "")?.push(s);
    for (const list of groups.values())
      list.sort(
        (a, b) =>
          (a.laneOrder ?? Infinity) - (b.laneOrder ?? Infinity) ||
          lastActive(b) - lastActive(a),
      );
    return groups;
  }, [sessions, lanes]);
  const open = sessions.find((s) => s.id === openId);
  useEffect(() => {
    if (openId && !open) setOpenId("");
  }, [openId, open]);

  async function place(s: Session, lane: string) {
    try {
      await window.workspace.invoke("session.place", {
        sessionId: s.id,
        generation: s.generation,
        lane,
        placementRevision: s.placementRevision ?? 0,
      });
    } catch (e) {
      report(e);
    }
  }
  async function changeLanes(
    command: "lane.add" | "lane.rename" | "lane.remove",
    payload: Record<string, unknown>,
  ) {
    try {
      await window.workspace.invoke(command, {
        projectId: project.id,
        revision: board.revision,
        ...payload,
      });
      return true;
    } catch (e) {
      report(e);
      return false;
    }
  }
  /** Starts a session through the normal launch, then files it in `lane`. */
  async function startIn(lane: string, provider: Provider) {
    const created = await onLaunch(provider);
    if (created) await place(created, lane);
  }
  /** Resume and New keep the follow-up session in the ended card's lane. */
  async function follow(
    s: Session,
    action: (s: Session) => Promise<Session | undefined>,
    openAfter: boolean,
  ) {
    const lane = laneOf(s, lanes);
    const created = await action(s);
    if (!created) return;
    if (lane) await place(created, lane);
    if (openAfter) setOpenId(created.id);
  }

  return (
    <div className="board-view session-board-view">
      <header className="view-head">
        <div>
          <div className="board-title">
            <h2>Board</h2>
            {modeSwitch}
          </div>
          <p>
            Every session in this folder is a card. Moving a card only files it;
            the process keeps running untouched.
          </p>
        </div>
      </header>
      <div
        className="lanes"
        aria-label="Session lanes"
        style={{ "--lane-count": lanes.length } as CSSProperties}
      >
        {lanes.map((lane) => {
          const cards = byLane.get(lane.id) || [];
          const ended = cards
            .filter((s) => s.status === "exited")
            .sort((a, b) => lastActive(b) - lastActive(a));
          const hidden = expanded[lane.id]
            ? new Set<string>()
            : new Set(ended.slice(ENDED_VISIBLE).map((s) => s.id));
          return (
            <Lane
              key={lane.id}
              id={lane.id}
              name={lane.name}
              count={cards.length}
              removable={!cards.length && lanes.length > 1}
              dropping={dropLane === lane.id}
              capabilities={capabilities}
              launchDisabled={!!disabledReason || !!launching}
              onRename={(name) => changeLanes("lane.rename", { laneId: lane.id, name })}
              onRemove={() => void changeLanes("lane.remove", { laneId: lane.id })}
              onStart={(provider) => void startIn(lane.id, provider)}
              onDragOver={(active) =>
                setDropLane((current) =>
                  active ? lane.id : current === lane.id ? "" : current,
                )
              }
              onDrop={(sessionId) => {
                setDropLane("");
                const s = sessions.find((x) => x.id === sessionId);
                if (s && laneOf(s, lanes) !== lane.id) void place(s, lane.id);
              }}
            >
              {cards
                .filter((s) => !hidden.has(s.id))
                .map((s) => (
                  <SessionCard
                    key={s.id}
                    session={s}
                    project={project}
                    title={titleOf(s)}
                    now={now}
                    lane={lane.id}
                    lanes={lanes}
                    onOpen={() => setOpenId(s.id)}
                    onMove={(target) => void place(s, target)}
                    onResume={() => void follow(s, onResume, true)}
                    onRestart={() => void follow(s, onRestart, true)}
                  />
                ))}
              {hidden.size ? (
                <button
                  className="board-add lane-more"
                  onClick={() =>
                    setExpanded((current) => ({ ...current, [lane.id]: true }))
                  }
                >
                  Show {hidden.size} more ended
                </button>
              ) : null}
              {!cards.length ? (
                <p className="lane-empty">
                  Drop a card here or start a session with +.
                </p>
              ) : null}
            </Lane>
          );
        })}
        {lanes.length < MAX_LANES ? (
          <div className="lane-new">
            {adding ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await changeLanes("lane.add", { name: newLane })) {
                    setAdding(false);
                    setNewLane("");
                  }
                }}
              >
                <input
                  autoFocus
                  aria-label="New lane name"
                  maxLength={LANE_NAME_LIMIT}
                  value={newLane}
                  placeholder="Lane name"
                  onChange={(e) => setNewLane(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setAdding(false);
                    }
                  }}
                />
                <button className="button small" disabled={!newLane.trim()}>
                  Add
                </button>
              </form>
            ) : (
              <button className="board-add" onClick={() => setAdding(true)}>
                <Plus size={13} />
                Add lane
              </button>
            )}
          </div>
        ) : null}
      </div>
      {open ? (
        <LiveCard
          session={open}
          project={project}
          title={titleOf(open)}
          lane={laneOf(open, lanes) || ""}
          lanes={lanes}
          onMove={(target) => void place(open, target)}
          onResume={(s) => void follow(s, onResume, true)}
          onRestart={(s) => void follow(s, onRestart, true)}
          onEnded={onEnded}
          report={report}
          close={() => setOpenId("")}
        />
      ) : null}
    </div>
  );
}

function Lane({
  id,
  name,
  count,
  removable,
  dropping,
  capabilities,
  launchDisabled,
  onRename,
  onRemove,
  onStart,
  onDragOver,
  onDrop,
  children,
}: {
  id: string;
  name: string;
  count: number;
  removable: boolean;
  dropping: boolean;
  capabilities: Capability[];
  launchDisabled: boolean;
  onRename: (name: string) => Promise<boolean>;
  onRemove: () => void;
  onStart: (provider: Provider) => void;
  onDragOver: (active: boolean) => void;
  onDrop: (sessionId: string) => void;
  children: ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const [menu, setMenu] = useState<"start" | "lane" | null>(null);
  const startRename = () => {
    setMenu(null);
    setDraft(name);
    setRenaming(true);
  };
  const accepts = (e: DragEvent) =>
    e.dataTransfer.types.includes(DRAG_TYPE) ||
    e.dataTransfer.types.includes("text/plain");
  return (
    <section
      className={"lane" + (dropping ? " drop-target" : "")}
      data-lane={id}
      aria-label={`${name} lane`}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          onDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(
          e.dataTransfer.getData(DRAG_TYPE) || e.dataTransfer.getData("text/plain"),
        );
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && menu) {
          e.stopPropagation();
          setMenu(null);
        }
      }}
    >
      <header className="lane-head">
        {renaming ? (
          <input
            className="lane-rename"
            aria-label="Lane name"
            autoFocus
            maxLength={LANE_NAME_LIMIT}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => setRenaming(false)}
            onKeyDown={async (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (draft.trim() === name || (await onRename(draft)))
                  setRenaming(false);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setRenaming(false);
              }
            }}
          />
        ) : (
          <strong
            className="lane-name"
            title="Double-click to rename"
            onDoubleClick={startRename}
          >
            {name}
          </strong>
        )}
        <span className="lane-count">{count}</span>
        <button
          className="icon-button"
          aria-label={`Start a session in ${name}`}
          aria-expanded={menu === "start"}
          title="Start Claude, Codex or a shell in this lane"
          disabled={launchDisabled}
          onClick={() => setMenu((m) => (m === "start" ? null : "start"))}
        >
          <Plus size={14} />
        </button>
        <button
          className="icon-button"
          aria-label={`Lane actions for ${name}`}
          aria-expanded={menu === "lane"}
          onClick={() => setMenu((m) => (m === "lane" ? null : "lane"))}
        >
          <Ellipsis size={14} />
        </button>
      </header>
      {menu === "start" ? (
        <div className="lane-menu" role="menu" aria-label={`Start in ${name}`}>
          {providers.map((provider) => {
            const cap = capability(capabilities, provider);
            return (
              <button
                key={provider}
                role="menuitem"
                disabled={launchDisabled}
                onClick={() => {
                  setMenu(null);
                  onStart(provider);
                }}
              >
                <ProviderGlyph provider={provider} size={13} />
                {providerName(provider)}
                {cap && !cap.available ? <small>Not found</small> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {menu === "lane" ? (
        <div className="lane-menu" role="menu" aria-label={`Actions for ${name}`}>
          <button role="menuitem" onClick={startRename}>
            <Pencil size={12} />
            Rename lane
          </button>
          <button
            role="menuitem"
            disabled={!removable}
            title={
              removable
                ? "Remove this empty lane"
                : "Only an empty lane can be removed, and a board keeps one lane"
            }
            onClick={() => {
              setMenu(null);
              onRemove();
            }}
          >
            <X size={12} />
            Remove lane
          </button>
        </div>
      ) : null}
      <div className="lane-cards">{children}</div>
    </section>
  );
}

function SessionCard({
  session: s,
  project,
  title,
  now,
  lane,
  lanes,
  onOpen,
  onMove,
  onResume,
  onRestart,
}: {
  session: Session;
  project: Project;
  title: string;
  now: number;
  lane: string;
  lanes: BoardLanes["lanes"];
  onOpen: () => void;
  onMove: (lane: string) => void;
  onResume: () => void;
  onRestart: () => void;
}) {
  const [moving, setMoving] = useState(false);
  const moveButton = useRef<HTMLButtonElement>(null);
  const state = sessionState(s);
  const ended = s.status === "exited";
  const location = sessionLocation(s, project);
  return (
    <article
      className={
        "session-card tone-" + state.tone + (ended ? " is-ended" : "")
      }
      data-session-id={s.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, s.id);
        e.dataTransfer.setData("text/plain", s.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && moving) {
          e.stopPropagation();
          setMoving(false);
          moveButton.current?.focus();
        }
      }}
    >
      <button
        className="session-card-open"
        title="Open the live terminal"
        onClick={onOpen}
      >
        <ProviderGlyph provider={s.provider} size={14} />
        <strong>{title}</strong>
      </button>
      <div className="session-card-state">
        <StatusBadge session={s} />
        <span className="session-card-time">{ago(lastActive(s), now)}</span>
      </div>
      <div className="session-card-meta" title={s.cwd}>
        <code>{location === "/" ? project.name : location}</code>
        {s.model ? <span>· {s.model}</span> : null}
      </div>
      <footer>
        {ended ? (
          <>
            {canResume(s) ? (
              <button className="button ghost small" onClick={onResume}>
                <History size={12} />
                Resume
              </button>
            ) : null}
            <button className="button ghost small" onClick={onRestart}>
              <Play size={11} />
              New here
            </button>
          </>
        ) : null}
        <button
          ref={moveButton}
          className="button ghost small move-button"
          aria-expanded={moving}
          aria-label={`Move to… (${title})`}
          onClick={() => setMoving((m) => !m)}
        >
          <MoveRight size={12} />
          Move to…
        </button>
      </footer>
      {moving ? (
        <div className="lane-menu move-menu" role="menu" aria-label="Move to lane">
          {lanes.map((l) => (
            <button
              key={l.id}
              role="menuitem"
              disabled={l.id === lane}
              onClick={() => {
                setMoving(false);
                onMove(l.id);
              }}
            >
              {l.name}
              {l.id === lane ? <small>current</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

/** The real terminal for one card. Closing only detaches this viewer. */
function LiveCard({
  session,
  project,
  title,
  lane,
  lanes,
  onMove,
  onResume,
  onRestart,
  onEnded,
  report,
  close,
}: {
  session: Session;
  project: Project;
  title: string;
  lane: string;
  lanes: BoardLanes["lanes"];
  onMove: (lane: string) => void;
  onResume: (s: Session) => void;
  onRestart: (s: Session) => void;
  onEnded: (s: Session) => void;
  report: (error: unknown) => void;
  close: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    // Escape inside the terminal belongs to the program running there.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as Element | null;
      if (target?.closest?.(".xterm, .modal")) return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => previous?.focus?.();
  }, []);
  return (
    <div
      className="modal-backdrop live-card-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        ref={panel}
        className={"live-card tone-" + sessionState(session).tone}
        role="dialog"
        aria-modal="true"
        aria-label={`Live card: ${title}`}
        tabIndex={-1}
      >
        <header className="live-card-head">
          <label>
            Lane
            <select
              aria-label="Lane"
              value={lane}
              onChange={(e) => onMove(e.target.value)}
            >
              {lanes.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <span className="live-card-hint">
            Closing detaches this view; the session keeps running.
          </span>
          <button
            className="icon-button"
            aria-label="Close live card"
            title="Close (Esc outside the terminal)"
            onClick={close}
          >
            <X size={17} />
          </button>
        </header>
        <SessionView
          key={session.id}
          session={session}
          project={project}
          title={title}
          onResume={onResume}
          onRestart={onRestart}
          onEnded={onEnded}
          report={report}
        />
      </section>
    </div>
  );
}
