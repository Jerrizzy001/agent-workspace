import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
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
} from "../shared/contracts";
import { TerminalView } from "./TerminalView";
import { DictationButton } from "./DictationControl";
import { dictationAvailable } from "./dictation";
import { registerLeaveGuard } from "./leaveWorkspace";
import { providerName, providers } from "./sessions";
import { ProviderGlyph, StatusBadge } from "./ui";
type CanvasData = {
  session?: Session;
  attempt?: Attempt;
  note?: Note;
  saveNote?: (note: Note, body: string) => Promise<Note>;
};
function CanvasNote({
  note,
  saveNote,
}: {
  note: Note;
  saveNote: (note: Note, body: string) => Promise<Note>;
}) {
  const [body, setBody] = useState(note.body);
  const draft = useRef(note.body);
  const saved = useRef(note.body);
  const currentNote = useRef(note);
  const acceptedVersion = useRef(note.updatedAt);
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
        acceptedVersion.current =
          updated.updatedAt > acceptedVersion.current
            ? updated.updatedAt
            : acceptedVersion.current;
        const latest = currentNote.current;
        if (
          draft.current === body &&
          latest.updatedAt > acceptedVersion.current
        ) {
          acceptedVersion.current = latest.updatedAt;
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
    // A snapshot may arrive before the save acknowledgement. Keep the local
    // draft authoritative until that write settles, and never apply an older
    // snapshot over an acknowledged edit. Clean notes still follow newer edits
    // made in another browser.
    if (
      saving.current ||
      draft.current !== saved.current ||
      note.updatedAt <= acceptedVersion.current
    )
      return;
    acceptedVersion.current = note.updatedAt;
    draft.current = note.body;
    saved.current = note.body;
    setBody(note.body);
  }, [note.body, note.updatedAt]);
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
  const [dictationToggle, setDictationToggle] = useState(0);
  return (
    <div
      className={
        "canvas-card " + (data.session ? "canvas-terminal" : "canvas-note")
      }
    >
      <header>
        <span className="canvas-card-title">
          {data.session ? (
            <>
              <ProviderGlyph provider={data.session.provider} size={13} />
              {data.session.title || providerName(data.session.provider)}
            </>
          ) : (
            data.note?.title
          )}
        </span>
        {data.session ? (
          <span className="canvas-card-actions nodrag">
            {dictationAvailable() && data.session.status === "running" ? (
              <DictationButton
                compact
                viewerId={viewerId}
                onToggle={() => setDictationToggle((value) => value + 1)}
              />
            ) : null}
            <StatusBadge session={data.session} />
          </span>
        ) : (
          <span className="muted">
            {data.note?.source === "agent" ? "AGENT NOTE" : "NOTE"}
          </span>
        )}
      </header>
      {data.session ? (
        <div className="nodrag nowheel terminal-in-node">
          <TerminalView
            session={data.session}
            onViewer={setViewerId}
            dictationToggle={dictationToggle}
          />
        </div>
      ) : data.note && data.saveNote ? (
        <CanvasNote note={data.note} saveNote={data.saveNote} />
      ) : null}
    </div>
  );
}
const nodeTypes = { workspace: WorkspaceNode };
export function CanvasView({
  projectId,
  attempts,
  sessions,
  notes,
  layout,
  report,
  onCreate,
}: {
  projectId: string;
  attempts: Attempt[];
  sessions: Session[];
  notes: Note[];
  layout?: Layout;
  report: (e: unknown) => void;
  /** Creates a node's backing session or note and returns its node id. */
  onCreate?: (kind: Provider | "note") => Promise<string | undefined>;
}) {
  const [nodes, setNodes] = useState<Node<CanvasData>[]>([]);
  const flow = useRef<ReactFlowInstance<Node<CanvasData>> | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    position: { x: number; y: number };
  } | null>(null);
  // Positions chosen by right-click, applied whether the node or its id arrives first.
  const placed = useRef<Record<string, { x: number; y: number }>>({});
  useEffect(() => {
    const timer = setTimeout(() => {
      void flow.current?.fitView({ padding: 0.16, duration: 150 });
    }, 70);
    return () => clearTimeout(timer);
  }, [nodes.length]);
  const history = useRef<Record<string, { x: number; y: number }>[]>([]);
  const future = useRef<Record<string, { x: number; y: number }>[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const positions = () =>
    Object.fromEntries(nodes.map((n) => [n.id, n.position]));
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
          title: note.title,
          body,
        })
        .catch((error) => {
          report(error);
          throw error;
        });
    },
    [projectId, report],
  );
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
        (session) => session.attemptId || session.status !== "exited",
      );
      const items: Node<CanvasData>[] = shown.map((session, i) => {
        const nodeId = session.attemptId || session.id;
        return {
          id: nodeId,
          type: "workspace",
          position: placed.current[nodeId] ||
            layout?.positions[nodeId] || {
              x: 40 + (i % 2) * 680,
              y: 40 + Math.floor(i / 2) * 460,
            },
          data: {
            attempt: attempts.find((a) => a.id === session.attemptId),
            session,
          },
        };
      });
      notes.forEach((note, i) =>
        items.push({
          id: note.id,
          type: "workspace",
          position: placed.current[note.id] ||
            layout?.positions[note.id] || {
              x: 80 + i * 340,
              y: Math.ceil(shown.length / 2) * 460 + 50,
            },
          data: { note, saveNote },
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
  }, [attempts, sessions, notes, layout, saveNote]);
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
      <div className="canvas-history" data-version={historyVersion}>
        <button disabled={!history.current.length} onClick={() => travel(true)}>
          ↶ Undo move
        </button>
        <button disabled={!future.current.length} onClick={() => travel(false)}>
          ↷ Redo
        </button>
      </div>
      <ReactFlow
        onInit={(instance) => {
          flow.current = instance;
        }}
        nodes={nodes}
        nodeTypes={nodeTypes}
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
        fitView
        minZoom={0.2}
        maxZoom={1.5}
        colorMode="dark"
      >
        <Background gap={24} size={1} color="#262d3a" />
        <Controls showInteractive={false} />
        <MiniMap nodeColor="#3a4560" maskColor="#0b0d12bb" />
      </ReactFlow>
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
            <span className="glyph" aria-hidden="true">✎</span>
            Note
          </button>
        </div>
      ) : null}
      {!nodes.length ? (
        <div className="canvas-empty">
          Your sessions, spatially.
          <span>
            Right-click the canvas to add Claude, Codex, a shell or a note.
          </span>
        </div>
      ) : null}
    </div>
  );
}
