import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  Position,
  MarkerType,
  type Edge,
  applyNodeChanges,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  Attempt,
  Layout,
  Note,
  Provider,
  Session,
  TranscriptLinkView,
} from "../shared/contracts";
import { TerminalView } from "./TerminalView";
import { DictationToolbar } from "./DictationControl";
import { dictationAvailable } from "./dictation";
import { registerLeaveGuard } from "./leaveWorkspace";
import { providerName, providers } from "./sessions";
import { TranscriptLinksPanel } from "./TranscriptLinksPanel";
import { AgentControlButton } from "./AgentControl";
import { profilesAvailable } from "./ProfilesPanel";
import { ProviderGlyph, StatusBadge } from "./ui";
type CanvasData = {
  session?: Session;
  attempt?: Attempt;
  note?: Note;
  saveNote?: (note: Note, body: string) => Promise<Note>;
  title?: string;
  open?: () => void;
  connect?: () => void;
  rename?: (title: string) => Promise<void>;
  hide?: () => Promise<void>;
  move?: (dx: number, dy: number) => void;
  report?: (e: unknown) => void;
};
function CanvasNote({
  note,
  saveNote,
  onFlushReady,
}: {
  note: Note;
  saveNote: (note: Note, body: string) => Promise<Note>;
  onFlushReady?: (flush: (() => Promise<void>) | null) => void;
}) {
  const [body, setBody] = useState(note.body);
  const draft = useRef(note.body);
  const saved = useRef(note.body);
  const currentNote = useRef(note);
  const acceptedVersion = useRef(note);
  const newer = (a: Note, b: Note) =>
    (a.revision ?? 1) !== (b.revision ?? 1)
      ? (a.revision ?? 1) > (b.revision ?? 1)
      : a.updatedAt > b.updatedAt;
  currentNote.current = note;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const save = useRef(saveNote);
  save.current = saveNote;
  const flush = useCallback((): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (saving.current) return saving.current.then(flush);
    if (draft.current === saved.current) return Promise.resolve();
    const body = draft.current;
    const operation = save
      .current(currentNote.current, body)
      .then((updated) => {
        saved.current = body;
        if (newer(updated, acceptedVersion.current))
          acceptedVersion.current = updated;
        const latest = currentNote.current;
        if (draft.current === body && newer(latest, acceptedVersion.current)) {
          acceptedVersion.current = latest;
          draft.current = latest.body;
          saved.current = latest.body;
          setBody(latest.body);
        }
      });
    saving.current = operation;
    return operation
      .finally(() => {
        saving.current = null;
      })
      .then(() => (draft.current === saved.current ? undefined : flush()));
  }, [note.id]);
  useEffect(() => {
    onFlushReady?.(flush);
    return () => onFlushReady?.(null);
  }, [flush, onFlushReady]);
  useEffect(() => {
    // A snapshot may arrive before the save acknowledgement. Keep the local
    // draft authoritative until that write settles, and never apply an older
    // snapshot over an acknowledged edit. Clean notes still follow newer edits
    // made in another browser.
    if (
      saving.current ||
      draft.current !== saved.current ||
      !newer(note, acceptedVersion.current)
    )
      return;
    acceptedVersion.current = note;
    draft.current = note.body;
    saved.current = note.body;
    setBody(note.body);
  }, [note.body, note.updatedAt, note.revision]);
  useEffect(
    () =>
      registerLeaveGuard(async () => {
        await flush();
        return true;
      }),
    [flush],
  );
  useEffect(() => {
    const preventUnsavedClose = (event: BeforeUnloadEvent) => {
      if (draft.current === saved.current && !saving.current) return;
      void flush().catch(() => {});
      event.preventDefault();
      event.returnValue = "Unsaved canvas note";
    };
    window.addEventListener("beforeunload", preventUnsavedClose);
    return () => {
      window.removeEventListener("beforeunload", preventUnsavedClose);
      void flush().catch(() => {});
    };
  }, [flush]);
  return (
    <textarea
      className="nodrag nowheel"
      aria-label="Canvas note"
      value={body}
      onChange={(event) => {
        draft.current = event.target.value;
        setBody(event.target.value);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush().catch(() => {}), 200);
      }}
      onBlur={() => void flush().catch(() => {})}
    />
  );
}
function WorkspaceNode({ data }: NodeProps<Node<CanvasData>>) {
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const flushNote = useRef<(() => Promise<void>) | null>(null);
  const registerFlush = useCallback((flush: (() => Promise<void>) | null) => {
    flushNote.current = flush;
  }, []);
  const [dictationToggle, setDictationToggle] = useState(0);
  return (
    <div
      className={
        "canvas-card " + (data.session ? "canvas-terminal" : "canvas-note")
      }
    >
      {data.session && profilesAvailable() && !data.session.hostId ? (
        <>
          {data.session.provider === "claude" && data.session.conversationId ? (
            <Handle
              type="source"
              position={Position.Top}
              style={{ left: "70%" }}
              aria-label="Share this conversation"
            />
          ) : null}
          {data.session.status === "running" ? (
            <Handle
              type="target"
              position={Position.Top}
              style={{ left: "30%" }}
              aria-label="Receive shared context"
            />
          ) : null}
        </>
      ) : null}
      <header className="canvas-drag-handle">
        <span className="canvas-card-title">
          {data.session ? (
            <>
              <ProviderGlyph provider={data.session.provider} size={13} />
              {data.title ||
                data.session.title ||
                providerName(data.session.provider)}
            </>
          ) : (
            data.note?.title
          )}
        </span>
        {data.session ? (
          <span className="canvas-card-actions nodrag">
            <StatusBadge session={data.session} />
          </span>
        ) : (
          <span className="muted">
            {data.note?.source === "agent" ? "AGENT NOTE" : "NOTE"}
          </span>
        )}
      </header>
      <div className="canvas-card-toolbar nodrag nowheel">
        {data.session ? (
          <button onClick={data.open}>Open terminal</button>
        ) : null}
        {data.connect ? <button onClick={data.connect}>Connect</button> : null}
        <button
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={`Actions for ${data.title || data.note?.title || "card"}`}
        >
          Actions
        </button>
        {menuOpen ? (
          <div className="canvas-card-menu">
            <button
              onClick={() => {
                setNaming(data.title || data.note?.title || "");
                setMenuOpen(false);
              }}
            >
              Rename
            </button>
            <button
              onClick={() => {
                void (async () => {
                  await flushNote.current?.();
                  await data.hide?.();
                })().catch(data.report);
                setMenuOpen(false);
              }}
            >
              {data.note ? "Archive note" : "Hide from canvas"}
            </button>
            <span>Move card</span>
            {[
              ["Left", -80, 0],
              ["Right", 80, 0],
              ["Up", 0, -80],
              ["Down", 0, 80],
            ].map(([name, x, y]) => (
              <button
                key={name}
                onClick={() => data.move?.(Number(x), Number(y))}
              >
                {name}
              </button>
            ))}
            {data.session && data.report ? (
              <AgentControlButton session={data.session} report={data.report} />
            ) : null}
          </div>
        ) : null}
        {naming !== null ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void data
                .rename?.(naming)
                .then(() => setNaming(null))
                .catch(data.report);
            }}
          >
            <input
              autoFocus
              aria-label="Card name"
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
            />
            <button>Save name</button>
            <button type="button" onClick={() => setNaming(null)}>
              Cancel
            </button>
          </form>
        ) : null}
      </div>
      {data.session ? (
        <div className="nodrag nowheel terminal-in-node">
          <TerminalView
            session={data.session}
            onViewer={setViewerId}
            dictationToggle={dictationToggle}
          />
        </div>
      ) : data.note && data.saveNote ? (
        <CanvasNote
          note={data.note}
          saveNote={data.saveNote}
          onFlushReady={registerFlush}
        />
      ) : null}
      {data.session?.status === "running" && dictationAvailable() ? (
        <DictationToolbar
          compact
          viewerId={viewerId}
          onToggle={() => setDictationToggle((value) => value + 1)}
        />
      ) : null}
    </div>
  );
}
function SnapshotEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY } = props;
  const routeY = Math.min(sourceY, targetY) - 60;
  const path = `M ${sourceX},${sourceY} L ${sourceX},${routeY + 12} Q ${sourceX},${routeY} ${sourceX + (targetX > sourceX ? 12 : -12)},${routeY} L ${targetX + (targetX > sourceX ? -12 : 12)},${routeY} Q ${targetX},${routeY} ${targetX},${routeY + 12} L ${targetX},${targetY - 10}`;
  return (
    <>
      <BaseEdge
        {...props}
        label={undefined}
        path={path}
        interactionWidth={24}
      />
      <EdgeLabelRenderer>
        <button
          className="snapshot-edge-label nodrag nopan"
          style={{
            transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px, ${routeY}px)`,
          }}
          onClick={() => {
            if (typeof props.data?.manage === "function") props.data.manage();
          }}
        >
          {props.label}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
const edgeTypes = { snapshot: SnapshotEdge };
const nodeTypes = { workspace: WorkspaceNode };
export function CanvasView({
  projectId,
  attempts,
  sessions,
  notes,
  layout,
  report,
  onCreate,
  onOpenSession,
  titleOf,
  connectRequested = false,
  onConnectHandled,
}: {
  projectId: string;
  attempts: Attempt[];
  sessions: Session[];
  notes: Note[];
  layout?: Layout;
  report: (e: unknown) => void;
  /** Creates a node's backing session or note and returns its node id. */
  onCreate?: (kind: Provider | "note") => Promise<string | undefined>;
  onOpenSession: (session: Session, draft?: string) => void;
  titleOf: (session: Session) => string;
  connectRequested?: boolean;
  onConnectHandled?: () => void;
}) {
  const [nodes, setNodes] = useState<Node<CanvasData>[]>([]);
  const liveNodes = useRef(nodes);
  liveNodes.current = nodes;
  const [connection, setConnection] = useState<{
    sourceId: string;
    recipientId?: string;
  } | null>(null);
  const [chooser, setChooser] = useState(false);
  const [links, setLinks] = useState<TranscriptLinkView[]>([]);
  const [showEnded, setShowEnded] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [undoHidden, setUndoHidden] = useState<(() => Promise<unknown>) | null>(
    null,
  );
  const [allowedReaders, setAllowedReaders] = useState<Set<string>>(new Set());
  const linkRequest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      linkRequest.current++;
    };
  }, []);
  const currentData = useRef({ sessions, notes });
  currentData.current = { sessions, notes };
  const local = profilesAvailable() && !sessions.some((s) => s.hostId);
  const refreshLinks = useCallback(async () => {
    if (!local) return;
    const request = ++linkRequest.current;
    try {
      const all =
        await window.workspace.invoke<TranscriptLinkView[]>("transcript.list");
      const ids = new Set(currentData.current.sessions.map((s) => s.id));
      const mine = all.filter(
        (l) =>
          !l.revokedAt &&
          ids.has(l.source.sessionId) &&
          ids.has(l.recipient.sessionId) &&
          currentData.current.sessions.find((s) => s.id === l.source.sessionId)
            ?.generation === l.source.generation &&
          currentData.current.sessions.find(
            (s) => s.id === l.recipient.sessionId,
          )?.generation === l.recipient.generation,
      );
      const states = await Promise.allSettled(
        [...new Set(mine.map((l) => l.recipient.sessionId))].map(
          async (id) => ({
            id,
            state: await window.workspace.agentControl!.list({ sessionId: id }),
          }),
        ),
      );
      if (!mounted.current || request !== linkRequest.current) return;
      setLinks(mine);
      setAllowedReaders(
        new Set(
          states.flatMap((r) =>
            r.status === "fulfilled" &&
            r.value.state.grant?.verbs.includes("transcript.read")
              ? [r.value.id]
              : [],
          ),
        ),
      );
    } catch (e) {
      if (mounted.current && request === linkRequest.current) report(e);
    }
  }, [local, report]);
  useEffect(() => {
    void refreshLinks();
    const timer = setInterval(() => void refreshLinks(), 5000);
    return () => clearInterval(timer);
  }, [refreshLinks]);
  useEffect(() => {
    if (connectRequested) {
      setChooser(true);
      onConnectHandled?.();
    }
  }, [connectRequested, onConnectHandled]);
  const flow = useRef<ReactFlowInstance<Node<CanvasData>> | null>(null);
  const [flowReady, setFlowReady] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    position: { x: number; y: number };
  } | null>(null);
  // Positions chosen by right-click, applied whether the node or its id arrives first.
  const placed = useRef<Record<string, { x: number; y: number }>>({});
  const fitted = useRef(false);
  useEffect(() => {
    if (!flowReady || !nodes.length || fitted.current) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void flow.current
        ?.fitView({ padding: 0.16, maxZoom: 0.9, minZoom: 0.65 })
        .then((applied) => {
          if (!cancelled && applied) fitted.current = true;
        });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [flowReady, nodes.length]);
  const history = useRef<Record<string, { x: number; y: number }>[]>([]);
  const future = useRef<Record<string, { x: number; y: number }>[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const positions = () =>
    Object.fromEntries(liveNodes.current.map((n) => [n.id, n.position]));
  // This view's recent saves: their echoes are not someone else's move.
  const sent = useRef<Record<string, { x: number; y: number }>[]>([]);
  function save(positions: Record<string, { x: number; y: number }>) {
    sent.current = [...sent.current.slice(-9), positions];
    void window.workspace
      .invoke("layout.save", { projectId, positions })
      .catch(report);
  }
  function travel(undo: boolean) {
    const source = undo ? history.current : future.current;
    const target = undo ? future.current : history.current;
    const previous = source.pop();
    if (!previous) return;
    target.push(positions());
    setNodes((current) =>
      current.map((n) => ({ ...n, position: previous[n.id] || n.position })),
    );
    save(previous);
    setHistoryVersion((v) => v + 1);
  }
  const saveNote = useCallback(
    (note: Note, body: string) => {
      return window.workspace
        .invoke<Note>("note.update", {
          noteId: note.id,
          projectId,
          body,
        })
        .catch((error) => {
          report(error);
          throw error;
        });
    },
    [projectId, report],
  );
  const actions = useRef<(s?: Session, n?: Note) => Partial<CanvasData>>(
    () => ({}),
  );
  actions.current = (s, n) => ({
    report,
    ...(s
      ? {
          title: titleOf(s),
          open: () => onOpenSession(s),
          ...(local
            ? {
                connect: () =>
                  s.provider === "claude" && s.conversationId
                    ? setConnection({ sourceId: s.id })
                    : setChooser(true),
              }
            : {}),
        }
      : {}),
    rename: async (title) => {
      if (s)
        await window.workspace.invoke("session.rename", {
          sessionId: s.id,
          generation: s.generation,
          title,
          titleRevision: s.titleRevision ?? 0,
        });
      else if (n) {
        const latest = (
          await window.workspace.invoke<{ notes: Note[] }>("snapshot")
        ).notes.find((x) => x.id === n.id);
        if (!latest) throw new Error("This note is no longer available");
        await window.workspace.invoke("note.update", {
          noteId: n.id,
          title,
          revision: latest.revision ?? 1,
        });
      }
    },
    hide: async () => {
      if (s) {
        await window.workspace.invoke("session.canvas", {
          sessionId: s.id,
          generation: s.generation,
          hidden: true,
        });
        setUndoHidden(
          () => () =>
            window.workspace.invoke("session.canvas", {
              sessionId: s.id,
              generation: s.generation,
              hidden: false,
            }),
        );
      } else if (n) {
        const latest = (
          await window.workspace.invoke<{ notes: Note[] }>("snapshot")
        ).notes.find((x) => x.id === n.id);
        if (!latest) throw new Error("This note is no longer available");
        const updated = await window.workspace.invoke<Note>("note.archive", {
          noteId: n.id,
          revision: latest.revision ?? 1,
          archived: true,
        });
        setUndoHidden(
          () => () =>
            window.workspace.invoke("note.archive", {
              noteId: n.id,
              revision: updated.revision,
              archived: false,
            }),
        );
      }
    },
    move: (dx, dy) => {
      const key = s ? s.attemptId || s.id : n!.id;
      const before = positions();
      const at = before[key];
      if (!at) return;
      history.current.push(before);
      future.current = [];
      const next = { ...before, [key]: { x: at.x + dx, y: at.y + dy } };
      setNodes((old) =>
        old.map((node) =>
          node.id === key ? { ...node, position: next[key]! } : node,
        ),
      );
      save(next);
      setHistoryVersion((v) => v + 1);
    },
  });
  // The last layout this view applied. A newer revision that moves a node
  // (for example `awctl canvas place`) is adopted unless that node is being
  // dragged; the owner's own saves echo back the positions already shown.
  const appliedLayout = useRef<Layout | undefined>(undefined);
  useEffect(() => {
    const before = appliedLayout.current;
    const external = (id: string) => {
      const next = layout?.positions[id];
      if (!next || !layout || (layout.revision ?? 1) <= (before?.revision ?? 0))
        return undefined;
      const old = before?.positions[id];
      if (sent.current.some((m) => m[id]?.x === next.x && m[id]?.y === next.y))
        return undefined;
      return !old || old.x !== next.x || old.y !== next.y ? next : undefined;
    };
    appliedLayout.current = layout;
    setNodes((previous) => {
      // Task attempts keep their attempt-keyed layout; folder sessions use the session id.
      // Ended folder sessions leave the canvas; their history stays in the sidebar.
      const shown = sessions.filter(
        (session) =>
          !session.canvasHidden && (showEnded || session.status !== "exited"),
      );
      const items: Node<CanvasData>[] = shown.map((session, i) => {
        const nodeId = session.attemptId || session.id;
        return {
          id: nodeId,
          type: "workspace",
          dragHandle: ".canvas-drag-handle",
          position: placed.current[nodeId] ||
            layout?.positions[nodeId] || {
              x: 40 + (i % 2) * 680,
              y: 40 + Math.floor(i / 2) * 460,
            },
          data: {
            attempt: attempts.find((a) => a.id === session.attemptId),
            session,
            ...actions.current(session),
          },
        };
      });
      notes
        .filter((n) => !n.archived)
        .forEach((note, i) =>
          items.push({
            id: note.id,
            type: "workspace",
            dragHandle: ".canvas-drag-handle",
            position: placed.current[note.id] ||
              layout?.positions[note.id] || {
                x: 80 + (i % 3) * 340,
                y:
                  Math.ceil(shown.length / 2) * 510 +
                  50 +
                  Math.floor(i / 3) * 290,
              },
            data: { note, saveNote, ...actions.current(undefined, note) },
          }),
        );
      return items.map((node) => {
        const shown = previous.find((n) => n.id === node.id);
        const moved = shown?.dragging ? undefined : external(node.id);
        if (moved) delete placed.current[node.id];
        return {
          ...node,
          position:
            moved ||
            placed.current[node.id] ||
            shown?.position ||
            node.position,
        };
      });
    });
  }, [attempts, sessions, notes, layout, saveNote, showEnded, titleOf]);
  async function create(kind: Provider | "note") {
    const target = menu;
    setMenu(null);
    if (!onCreate || !target) return;
    const nodeId = await onCreate(kind);
    if (!nodeId) return;
    placed.current[nodeId] = target.position;
    setNodes((current) =>
      current.map((n) =>
        n.id === nodeId ? { ...n, position: target.position } : n,
      ),
    );
    save({ ...positions(), [nodeId]: target.position });
  }
  const changes = useCallback(
    (changes: NodeChange<Node<CanvasData>>[]) =>
      setNodes((n) => applyNodeChanges(changes, n)),
    [],
  );
  function persist(_: unknown, node: Node<CanvasData>) {
    const next = { ...positions(), [node.id]: node.position };
    save(next);
    setHistoryVersion((v) => v + 1);
  }
  return (
    <div className="canvas-container" ref={container}>
      <div className="canvas-actions">
        <button
          className="button primary small"
          disabled={!local}
          onClick={() => setChooser(true)}
        >
          Connect agents
        </button>
        <button
          className="button small"
          onClick={() =>
            setMenu({
              x: 16,
              y: 66,
              position: flow.current?.screenToFlowPosition({
                x: (container.current?.getBoundingClientRect().left || 0) + 120,
                y: (container.current?.getBoundingClientRect().top || 0) + 180,
              }) || { x: 80, y: 80 },
            })
          }
        >
          Add to canvas
        </button>
        <label>
          <input
            type="checkbox"
            checked={showEnded}
            onChange={(e) => setShowEnded(e.target.checked)}
          />
          Show ended
        </label>
        <button onClick={() => setShowArchived((v) => !v)}>
          Hidden & archived
        </button>
        {undoHidden ? (
          <button
            onClick={() =>
              void undoHidden()
                .then(() => setUndoHidden(null))
                .catch(report)
            }
          >
            Undo removal
          </button>
        ) : null}
      </div>
      {showArchived ? (
        <section className="canvas-archived" aria-label="Hidden canvas items">
          <strong>Restore to canvas</strong>
          {sessions
            .filter((s) => s.canvasHidden)
            .map((s) => (
              <button
                key={s.id}
                onClick={() =>
                  void window.workspace
                    .invoke("session.canvas", {
                      sessionId: s.id,
                      generation: s.generation,
                      hidden: false,
                    })
                    .catch(report)
                }
              >
                Restore {titleOf(s)}
              </button>
            ))}
          {notes
            .filter((n) => n.archived)
            .map((n) => (
              <button
                key={n.id}
                onClick={() =>
                  void window.workspace
                    .invoke("note.archive", {
                      noteId: n.id,
                      revision: n.revision ?? 1,
                      archived: false,
                    })
                    .catch(report)
                }
              >
                Restore {n.title}
              </button>
            ))}
          {!sessions.some((s) => s.canvasHidden) &&
          !notes.some((n) => n.archived) ? (
            <p>Nothing hidden or archived.</p>
          ) : null}
        </section>
      ) : null}
      <div className="canvas-history" data-version={historyVersion}>
        <button disabled={!history.current.length} onClick={() => travel(true)}>
          ↶ Undo move
        </button>
        <button disabled={!future.current.length} onClick={() => travel(false)}>
          ↷ Redo
        </button>
      </div>
      <div className="canvas-flow">
        <ReactFlow<Node<CanvasData>, Edge>
          onInit={(instance) => {
            flow.current = instance;
            setFlowReady(true);
          }}
          nodes={nodes}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          edges={links.flatMap((l) => {
            const source = nodes.find(
              (n) => n.data.session?.id === l.source.sessionId,
            );
            const target = nodes.find(
              (n) => n.data.session?.id === l.recipient.sessionId,
            );
            return source && target
              ? [
                  {
                    id: l.id,
                    type: "snapshot",
                    ariaLabel: `Shared context from ${titleOf(source.data.session!)} to ${titleOf(target.data.session!)}. Open to manage this connection.`,
                    source: source.id,
                    target: target.id,
                    data: {
                      manage: () =>
                        setConnection({ sourceId: l.source.sessionId }),
                    },
                    label: `${titleOf(source.data.session!)} → ${titleOf(target.data.session!)} · ${!allowedReaders.has(l.recipient.sessionId) ? "Reading paused" : l.reads ? `Snapshot · read ${l.reads}×` : "Snapshot · not read yet"}`,
                    markerEnd: { type: MarkerType.ArrowClosed },
                    style: { stroke: "#8b9dff", strokeWidth: 2 },
                    labelStyle: { fill: "#e7ebf3" },
                    labelBgStyle: { fill: "#191e28" },
                  } satisfies Edge,
                ]
              : [];
          })}
          onConnect={(c) => {
            const source = nodes.find((n) => n.id === c.source)?.data.session;
            const target = nodes.find((n) => n.id === c.target)?.data.session;
            if (local && source && target && source.id !== target.id)
              setConnection({ sourceId: source.id, recipientId: target.id });
          }}
          onEdgeClick={(_, edge) => {
            const l = links.find((l) => l.id === edge.id);
            if (l) setConnection({ sourceId: l.source.sessionId });
          }}
          onNodesChange={changes}
          onNodeDragStart={() => {
            history.current.push(positions());
            future.current = [];
          }}
          onNodeDragStop={persist}
          deleteKeyCode={null}
          onPaneContextMenu={(event) => {
            if (!onCreate || !flow.current) return;
            event.preventDefault();
            const bounds = container.current!.getBoundingClientRect();
            setMenu({
              x: Math.min(event.clientX - bounds.left, bounds.width - 200),
              y: Math.min(event.clientY - bounds.top, bounds.height - 190),
              position: flow.current.screenToFlowPosition({
                x: event.clientX,
                y: event.clientY,
              }),
            });
          }}
          onPaneClick={() => setMenu(null)}
          defaultViewport={{ x: 20, y: 90, zoom: 0.8 }}
          minZoom={0.2}
          maxZoom={1.5}
          colorMode="dark"
        >
          <Background gap={24} size={1} color="#262d3a" />
          <Controls showInteractive={false} />
          <MiniMap nodeColor="#3a4560" maskColor="#0b0d12bb" />
        </ReactFlow>
      </div>
      {menu ? (
        <div
          className="canvas-menu"
          role="menu"
          aria-label="Add to canvas"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setMenu(null);
          }}
        >
          {providers.map((provider) => (
            <button
              key={provider}
              role="menuitem"
              autoFocus={provider === "claude"}
              onClick={() => void create(provider)}
            >
              <ProviderGlyph provider={provider} size={14} />
              New {providerName(provider)}
            </button>
          ))}
          <button role="menuitem" onClick={() => void create("note")}>
            <span className="glyph" aria-hidden="true">
              ✎
            </span>
            Note
          </button>
        </div>
      ) : null}
      {chooser ? (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Choose source agent"
          >
            <header>
              <h2>Connect agents</h2>
              <button aria-label="Close" onClick={() => setChooser(false)}>
                ×
              </button>
            </header>
            <p>
              Choose the Claude conversation to share. You will review its text
              and choose a recipient before granting access.
            </p>
            {sessions
              .filter(
                (s) => s.provider === "claude" && s.conversationId && !s.hostId,
              )
              .map((s) => (
                <button
                  key={s.id}
                  className="button"
                  onClick={() => {
                    setChooser(false);
                    setConnection({ sourceId: s.id });
                  }}
                >
                  {titleOf(s)}
                </button>
              ))}
            {!sessions.some(
              (s) => s.provider === "claude" && s.conversationId && !s.hostId,
            ) ? (
              <p>
                No shareable Claude conversations in this folder yet. Start
                Claude above and have a conversation first. Codex and shells can
                receive shared context.
              </p>
            ) : null}
          </section>
        </div>
      ) : null}
      {connection && sessions.find((s) => s.id === connection.sourceId) ? (
        <TranscriptLinksPanel
          session={sessions.find((s) => s.id === connection.sourceId)!}
          sessions={sessions}
          titleOf={titleOf}
          initialRecipientId={connection.recipientId}
          onClose={() => {
            setConnection(null);
            void refreshLinks();
          }}
          onChanged={() => void refreshLinks()}
          onOpenSession={onOpenSession}
        />
      ) : null}
      {!nodes.length ? (
        <div className="canvas-empty">
          Your sessions, spatially.
          <span>
            Use Add to canvas for a terminal or note. Use Connect agents to
            share a reviewed conversation snapshot.
          </span>
        </div>
      ) : null}
    </div>
  );
}
