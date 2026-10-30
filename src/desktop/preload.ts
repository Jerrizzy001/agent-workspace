import { contextBridge, ipcRenderer } from "electron";
import type { Command, CoreEvent, WorkspaceAPI } from "../shared/contracts";
const api: WorkspaceAPI = {
  invoke: <T>(command: Command, payload: Record<string, unknown> = {}) =>
    ipcRenderer.invoke("workspace:invoke", command, payload) as Promise<T>,
  subscribe: (listener: (event: CoreEvent) => void) => {
    const handler = (_event: unknown, value: CoreEvent) => listener(value);
    ipcRenderer.on("workspace:event", handler);
    return () => ipcRenderer.removeListener("workspace:event", handler);
  },
  chooseDirectory: () => ipcRenderer.invoke("workspace:chooseDirectory"),
};
contextBridge.exposeInMainWorld("workspace", api);
