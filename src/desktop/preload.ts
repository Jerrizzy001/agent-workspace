import { deltaReceiver } from "../shared/deltas";
import { contextBridge, ipcRenderer } from "electron";
import type {
  Command,
  CoreEvent,
  DictationStatus,
  MenuAction,
  PowerStatus,
  WorkspaceAPI,
} from "../shared/contracts";
// One materialized state per renderer, shared by every terminal/panel subscriber.
const receive = deltaReceiver();
const eventListeners = new Set<(event: CoreEvent) => void>();
let syncing = false;
let buffered: CoreEvent[] = [];
function broadcast(event: CoreEvent) {
  for (const listener of eventListeners) listener(event);
}
function receiveEvent(_event: unknown, value: CoreEvent) {
  if (value.type !== "workspace.delta" && value.type !== "snapshot") {
    broadcast(value);
    return;
  }
  if (syncing) {
    // A long resync cannot grow a renderer's queue without bound. A later gap
    // triggers another full read; no mutation or terminal input is replayed.
    if (buffered.length >= 256) buffered = [];
    buffered.push(value);
    return;
  }
  const decoded = receive.accept(value);
  if (decoded) {
    broadcast(decoded);
    return;
  }
  syncing = true;
  void ipcRenderer
    .invoke("workspace:sync")
    .then((event: CoreEvent) => {
      const snapshot = receive.accept(event);
      if (snapshot) broadcast(snapshot);
      syncing = false;
      const queued = buffered;
      buffered = [];
      for (const next of queued) {
        if (
          next.type === "workspace.delta" &&
          event.type === "snapshot" &&
          next.epoch === event.epoch &&
          next.sequence <= (event.sequence ?? 0)
        )
          continue;
        receiveEvent(undefined, next);
      }
    })
    .catch(() => {
      syncing = false;
      buffered = [];
    });
}
ipcRenderer.on("workspace:event", receiveEvent);
const api: WorkspaceAPI = {
  invoke: <T>(command: Command, payload: Record<string, unknown> = {}) =>
    ipcRenderer.invoke("workspace:invoke", command, payload) as Promise<T>,
  subscribe: (listener: (event: CoreEvent) => void) => {
    eventListeners.add(listener);
    const current = receive.current();
    if (current) listener(current);
    return () => {
      eventListeners.delete(listener);
    };
  },
  chooseDirectory: () => ipcRenderer.invoke("workspace:chooseDirectory"),
  browseDirectory: (path?: string) =>
    ipcRenderer.invoke("workspace:browse", path),
  remote: {
    status: () => ipcRenderer.invoke("workspace:remote", "status"),
    enable: (config) =>
      ipcRenderer.invoke("workspace:remote", "enable", config),
    disable: () => ipcRenderer.invoke("workspace:remote", "disable"),
    pairingSecret: () =>
      ipcRenderer.invoke("workspace:remote", "pairingSecret"),
    pairingLink: () => ipcRenderer.invoke("workspace:remote", "pairingLink"),
    pairingLinkPending: (id) =>
      ipcRenderer.invoke("workspace:remote", "pairingLinkPending", id),
    revokeSessions: () =>
      ipcRenderer.invoke("workspace:remote", "revokeSessions"),
    chooseTLSFile: (kind) =>
      ipcRenderer.invoke("workspace:remote", "chooseTLSFile", kind),
  },
  clipboardImage: {
    preview: () => ipcRenderer.invoke("workspace:clipboardImage", "preview"),
    save: (target) =>
      ipcRenderer.invoke("workspace:clipboardImage", "save", target),
    discard: (token) =>
      ipcRenderer.invoke("workspace:clipboardImage", "discard", token),
  },
  contextMenu: (items) => ipcRenderer.invoke("workspace:contextMenu", items),
  onMenu: (listener) => {
    const handler = (_event: unknown, action: MenuAction) => listener(action);
    ipcRenderer.on("workspace:menu", handler);
    ipcRenderer.send("workspace:menu-ready");
    return () => ipcRenderer.removeListener("workspace:menu", handler);
  },
  power: {
    status: () => ipcRenderer.invoke("workspace:power", "status"),
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke("workspace:power", "setEnabled", enabled),
    onStatus: (listener) => {
      const handler = (_event: unknown, value: PowerStatus) => listener(value);
      ipcRenderer.on("workspace:power", handler);
      return () => ipcRenderer.removeListener("workspace:power", handler);
    },
  },
  agentControl: {
    allowTranscript: (target) =>
      ipcRenderer.invoke("workspace:agent-control", "allowTranscript", target),
    list: (target) =>
      ipcRenderer.invoke("workspace:agent-control", "list", target),
    grant: (request) =>
      ipcRenderer.invoke("workspace:agent-control", "grant", request),
    revoke: (target) =>
      ipcRenderer.invoke("workspace:agent-control", "revoke", target),
  },
  dictation: {
    status: () => ipcRenderer.invoke("workspace:dictation", "status"),
    downloadModel: (modelId: string) =>
      ipcRenderer.invoke("workspace:dictation", "downloadModel", { modelId }),
    start: () => ipcRenderer.invoke("workspace:dictation", "start"),
    phrase: (input) =>
      ipcRenderer.invoke("workspace:dictation", "phrase", input),
    stop: (recordingId: string) =>
      ipcRenderer.invoke("workspace:dictation", "stop", { recordingId }),
    onStatus: (listener) => {
      const handler = (_event: unknown, value: DictationStatus) =>
        listener(value);
      ipcRenderer.on("workspace:dictation", handler);
      return () => ipcRenderer.removeListener("workspace:dictation", handler);
    },
  },
  ssh: {
    list: () => ipcRenderer.invoke("workspace:ssh", "list"),
    add: (input) => ipcRenderer.invoke("workspace:ssh", "add", input),
    probe: (hostId) => ipcRenderer.invoke("workspace:ssh", "probe", { hostId }),
    connect: (hostId, options) =>
      ipcRenderer.invoke("workspace:ssh", "connect", {
        hostId,
        ...(options?.approveUpgrade ? { approveUpgrade: true } : {}),
      }),
    disconnect: (hostId) =>
      ipcRenderer.invoke("workspace:ssh", "disconnect", { hostId }),
    browse: (hostId, path) =>
      ipcRenderer.invoke(
        "workspace:ssh",
        "browse",
        path === undefined ? { hostId } : { hostId, path },
      ),
    registerProject: (hostId, path) =>
      ipcRenderer.invoke("workspace:ssh", "registerProject", { hostId, path }),
    remove: (hostId) =>
      ipcRenderer.invoke("workspace:ssh", "remove", { hostId }),
  },
  profiles: {
    account: (input) =>
      ipcRenderer.invoke("workspace:profiles", "account", input),
    list: () => ipcRenderer.invoke("workspace:profiles", "list"),
    create: (input) =>
      ipcRenderer.invoke("workspace:profiles", "create", input),
    setup: (input) => ipcRenderer.invoke("workspace:profiles", "setup", input),
    check: (input) => ipcRenderer.invoke("workspace:profiles", "check", input),
    remove: (input) =>
      ipcRenderer.invoke("workspace:profiles", "remove", input),
  },
  team: {
    prepare: () => ipcRenderer.invoke("workspace:team", "prepare"),
    status: () => ipcRenderer.invoke("workspace:team", "status"),
    connect: (input) => ipcRenderer.invoke("workspace:team", "connect", input),
    disconnect: () => ipcRenderer.invoke("workspace:team", "disconnect"),
    publishProject: (input) =>
      ipcRenderer.invoke("workspace:team", "publishProject", input),
    revokeProject: (input) =>
      ipcRenderer.invoke("workspace:team", "revokeProject", input),
    previewTask: (input) =>
      ipcRenderer.invoke("workspace:team", "previewTask", input),
    publishTask: (input) =>
      ipcRenderer.invoke("workspace:team", "publishTask", input),
    unpublishTask: (input) =>
      ipcRenderer.invoke("workspace:team", "unpublishTask", input),
    sync: () => ipcRenderer.invoke("workspace:team", "sync"),
    boardInfo: (input) =>
      ipcRenderer.invoke("workspace:team", "boardInfo", input),
    sharedTasks: (input) =>
      ipcRenderer.invoke("workspace:team", "sharedTasks", input),
    taskDetail: (input) =>
      ipcRenderer.invoke("workspace:team", "taskDetail", input),
    members: (input) => ipcRenderer.invoke("workspace:team", "members", input),
    invite: (input) => ipcRenderer.invoke("workspace:team", "invite", input),
    setRole: (input) => ipcRenderer.invoke("workspace:team", "setRole", input),
    removeMember: (input) =>
      ipcRenderer.invoke("workspace:team", "removeMember", input),
    addComment: (input) =>
      ipcRenderer.invoke("workspace:team", "addComment", input),
    editComment: (input) =>
      ipcRenderer.invoke("workspace:team", "editComment", input),
    deleteComment: (input) =>
      ipcRenderer.invoke("workspace:team", "deleteComment", input),
    assign: (input) => ipcRenderer.invoke("workspace:team", "assign", input),
    resolve: (input) => ipcRenderer.invoke("workspace:team", "resolve", input),
    onChange: (listener) => {
      const handler = () => listener();
      ipcRenderer.on("workspace:team", handler);
      return () => ipcRenderer.removeListener("workspace:team", handler);
    },
  },
  assist: {
    status: () => ipcRenderer.invoke("workspace:assist", "status"),
    configure: (input) =>
      ipcRenderer.invoke("workspace:assist", "configure", input),
    previewCommit: (input) =>
      ipcRenderer.invoke("workspace:assist", "previewCommit", input),
    stagedHash: (input) =>
      ipcRenderer.invoke("workspace:assist", "stagedHash", input),
    suggestCommit: (input) =>
      ipcRenderer.invoke("workspace:assist", "suggestCommit", input),
    previewName: (input) =>
      ipcRenderer.invoke("workspace:assist", "previewName", input),
    suggestName: (input) =>
      ipcRenderer.invoke("workspace:assist", "suggestName", input),
    cancel: () => ipcRenderer.invoke("workspace:assist", "cancel"),
  },
};
contextBridge.exposeInMainWorld("workspace", api);
