import { contextBridge, ipcRenderer } from "electron";
import type { Command, CoreEvent, DictationStatus, PowerStatus, WorkspaceAPI } from "../shared/contracts";
const api: WorkspaceAPI = {
  invoke: <T>(command: Command, payload: Record<string, unknown> = {}) =>
    ipcRenderer.invoke("workspace:invoke", command, payload) as Promise<T>,
  subscribe: (listener: (event: CoreEvent) => void) => {
    const handler = (_event: unknown, value: CoreEvent) => listener(value);
    ipcRenderer.on("workspace:event", handler);
    return () => ipcRenderer.removeListener("workspace:event", handler);
  },
  chooseDirectory: () => ipcRenderer.invoke("workspace:chooseDirectory"),
  browseDirectory: (path?: string) => ipcRenderer.invoke("workspace:browse", path),
  remote: {
    status: () => ipcRenderer.invoke("workspace:remote", "status"),
    enable: (config) => ipcRenderer.invoke("workspace:remote", "enable", config),
    disable: () => ipcRenderer.invoke("workspace:remote", "disable"),
    pairingSecret: () => ipcRenderer.invoke("workspace:remote", "pairingSecret"),
    revokeSessions: () => ipcRenderer.invoke("workspace:remote", "revokeSessions"),
    chooseTLSFile: (kind) => ipcRenderer.invoke("workspace:remote", "chooseTLSFile", kind),
  },
  clipboardImage: {
    preview: () => ipcRenderer.invoke("workspace:clipboardImage", "preview"),
    save: (target) => ipcRenderer.invoke("workspace:clipboardImage", "save", target),
    discard: (token) => ipcRenderer.invoke("workspace:clipboardImage", "discard", token),
  },
  power: {
    status: () => ipcRenderer.invoke("workspace:power", "status"),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke("workspace:power", "setEnabled", enabled),
    onStatus: (listener) => {
      const handler = (_event: unknown, value: PowerStatus) => listener(value);
      ipcRenderer.on("workspace:power", handler);
      return () => ipcRenderer.removeListener("workspace:power", handler);
    },
  },
  agentControl: {
    list: (target) => ipcRenderer.invoke("workspace:agent-control", "list", target),
    grant: (request) => ipcRenderer.invoke("workspace:agent-control", "grant", request),
    revoke: (target) => ipcRenderer.invoke("workspace:agent-control", "revoke", target),
  },
  dictation: {
    status: () => ipcRenderer.invoke("workspace:dictation", "status"),
    downloadModel: (modelId: string) => ipcRenderer.invoke("workspace:dictation", "downloadModel", { modelId }),
    start: () => ipcRenderer.invoke("workspace:dictation", "start"),
    phrase: (input) => ipcRenderer.invoke("workspace:dictation", "phrase", input),
    stop: (recordingId: string) => ipcRenderer.invoke("workspace:dictation", "stop", { recordingId }),
    onStatus: (listener) => {
      const handler = (_event: unknown, value: DictationStatus) => listener(value);
      ipcRenderer.on("workspace:dictation", handler);
      return () => ipcRenderer.removeListener("workspace:dictation", handler);
    },
  },
  ssh: {
    list: () => ipcRenderer.invoke("workspace:ssh", "list"),
    add: (input) => ipcRenderer.invoke("workspace:ssh", "add", input),
    probe: (hostId) => ipcRenderer.invoke("workspace:ssh", "probe", { hostId }),
    connect: (hostId, options) =>
      ipcRenderer.invoke("workspace:ssh", "connect", { hostId, ...(options?.approveUpgrade ? { approveUpgrade: true } : {}) }),
    disconnect: (hostId) => ipcRenderer.invoke("workspace:ssh", "disconnect", { hostId }),
    browse: (hostId, path) => ipcRenderer.invoke("workspace:ssh", "browse", path === undefined ? { hostId } : { hostId, path }),
    registerProject: (hostId, path) => ipcRenderer.invoke("workspace:ssh", "registerProject", { hostId, path }),
    remove: (hostId) => ipcRenderer.invoke("workspace:ssh", "remove", { hostId }),
  },
  team: {
    status: () => ipcRenderer.invoke("workspace:team", "status"),
    connect: (input) => ipcRenderer.invoke("workspace:team", "connect", input),
    disconnect: () => ipcRenderer.invoke("workspace:team", "disconnect"),
    publishProject: (input) => ipcRenderer.invoke("workspace:team", "publishProject", input),
    revokeProject: (input) => ipcRenderer.invoke("workspace:team", "revokeProject", input),
    previewTask: (input) => ipcRenderer.invoke("workspace:team", "previewTask", input),
    publishTask: (input) => ipcRenderer.invoke("workspace:team", "publishTask", input),
    unpublishTask: (input) => ipcRenderer.invoke("workspace:team", "unpublishTask", input),
    sync: () => ipcRenderer.invoke("workspace:team", "sync"),
    boardInfo: (input) => ipcRenderer.invoke("workspace:team", "boardInfo", input),
    sharedTasks: (input) => ipcRenderer.invoke("workspace:team", "sharedTasks", input),
    taskDetail: (input) => ipcRenderer.invoke("workspace:team", "taskDetail", input),
    members: (input) => ipcRenderer.invoke("workspace:team", "members", input),
    invite: (input) => ipcRenderer.invoke("workspace:team", "invite", input),
    setRole: (input) => ipcRenderer.invoke("workspace:team", "setRole", input),
    removeMember: (input) => ipcRenderer.invoke("workspace:team", "removeMember", input),
    addComment: (input) => ipcRenderer.invoke("workspace:team", "addComment", input),
    editComment: (input) => ipcRenderer.invoke("workspace:team", "editComment", input),
    deleteComment: (input) => ipcRenderer.invoke("workspace:team", "deleteComment", input),
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
    configure: (input) => ipcRenderer.invoke("workspace:assist", "configure", input),
    previewCommit: (input) => ipcRenderer.invoke("workspace:assist", "previewCommit", input),
    stagedHash: (input) => ipcRenderer.invoke("workspace:assist", "stagedHash", input),
    suggestCommit: (input) => ipcRenderer.invoke("workspace:assist", "suggestCommit", input),
    previewName: (input) => ipcRenderer.invoke("workspace:assist", "previewName", input),
    suggestName: (input) => ipcRenderer.invoke("workspace:assist", "suggestName", input),
    cancel: () => ipcRenderer.invoke("workspace:assist", "cancel"),
  },
};
contextBridge.exposeInMainWorld("workspace", api);
