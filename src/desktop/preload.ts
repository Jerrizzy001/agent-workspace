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
};
contextBridge.exposeInMainWorld("workspace", api);
