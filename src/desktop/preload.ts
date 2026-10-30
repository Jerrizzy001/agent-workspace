import { contextBridge, ipcRenderer } from "electron";
import type { Command, CoreEvent, PowerStatus, WorkspaceAPI } from "../shared/contracts";
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
};
contextBridge.exposeInMainWorld("workspace", api);
