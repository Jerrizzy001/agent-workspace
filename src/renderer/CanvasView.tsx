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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Attempt, Layout, Note, Session } from "../shared/contracts";
import { TerminalView } from "./TerminalView";
type CanvasData = {
  session?: Session;
  attempt?: Attempt;
  note?: Note;
  saveNote?: (note: Note, body: string) => void;
};
function WorkspaceNode({ data }: NodeProps<Node<CanvasData>>) {
  return (
    <div
      className={
        "canvas-card " + (data.session ? "canvas-terminal" : "canvas-note")
      }
    >
      <header>
        <span>
          {data.session ? "›_ " + data.session.provider : data.note?.title}
        </span>
        <span className="muted">{data.session?.status || "NOTE"}</span>
      </header>
      {data.session ? (
        <div className="nodrag nowheel terminal-in-node">
          <TerminalView session={data.session} />
        </div>
      ) : (
        <textarea
          className="nodrag nowheel"
          aria-label="Canvas note"
          defaultValue={data.note?.body}
          onBlur={(e) =>
            data.note && data.saveNote?.(data.note, e.target.value)
          }
        />
      )}
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
}: {
  projectId: string;
  attempts: Attempt[];
  sessions: Session[];
  notes: Note[];
  layout?: Layout;
  report: (e: unknown) => void;
}) {
  const [nodes, setNodes] = useState<Node<CanvasData>[]>([]);
  const history = useRef<Record<string, { x: number; y: number }>[]>([]);
  const future = useRef<Record<string, { x: number; y: number }>[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const positions = () =>
    Object.fromEntries(nodes.map((n) => [n.id, n.position]));
  function save(positions: Record<string, { x: number; y: number }>) {
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
      void window.workspace
        .invoke("note.update", {
          noteId: note.id,
          projectId,
          title: note.title,
          body,
        })
        .catch(report);
    },
    [projectId, report],
  );
  useEffect(() => {
    setNodes((previous) => {
      const items: Node<CanvasData>[] = attempts.map((attempt, i) => ({
        id: attempt.id,
        type: "workspace",
        position: layout?.positions[attempt.id] || {
          x: 40 + (i % 2) * 680,
          y: 40 + Math.floor(i / 2) * 460,
        },
        data: {
          attempt,
          session: sessions.find((s) => s.id === attempt.sessionId),
        },
      }));
      notes.forEach((note, i) =>
        items.push({
          id: note.id,
          type: "workspace",
          position: layout?.positions[note.id] || {
            x: 80 + i * 340,
            y: Math.ceil(attempts.length / 2) * 460 + 50,
          },
          data: { note, saveNote },
        }),
      );
      return items.map((node) => ({
        ...node,
        position:
          previous.find((n) => n.id === node.id)?.position || node.position,
      }));
    });
  }, [attempts, sessions, notes, layout, saveNote]);
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
    <div className="canvas-container">
      <div className="canvas-history" data-version={historyVersion}>
        <button disabled={!history.current.length} onClick={() => travel(true)}>
          ↶ Undo move
        </button>
        <button disabled={!future.current.length} onClick={() => travel(false)}>
          ↷ Redo
        </button>
      </div>
      <ReactFlow
        nodes={nodes}
        nodeTypes={nodeTypes}
        onNodesChange={changes}
        onNodeDragStart={() => {
          history.current.push(positions());
          future.current = [];
        }}
        onNodeDragStop={persist}
        deleteKeyCode={null}
        fitView
        minZoom={0.2}
        maxZoom={1.5}
        colorMode="dark"
      >
        <Background gap={24} size={1} color="#34373a" />
        <Controls showInteractive={false} />
        <MiniMap nodeColor="#b88c52" maskColor="#111315aa" />
      </ReactFlow>
      {!nodes.length ? (
        <div className="canvas-empty">
          Your workspace, spatially.
          <span>
            Start an attempt or add a note to make room for your thinking.
          </span>
        </div>
      ) : null}
    </div>
  );
}
