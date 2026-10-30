import { app, BrowserWindow, dialog, ipcMain, utilityProcess } from "electron";
import path from "node:path";
import os from "node:os";
import { COMMANDS, type CoreEvent } from "../shared/contracts";
let window: BrowserWindow | null = null;
let core: Electron.UtilityProcess | null = null;
if (process.env.WORKSPACE_TEST_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.WORKSPACE_TEST_DATA_DIR));
let quitting = false;
let ready = false;
let shutdownComplete = false;
let shutdownStarted = false;
const readyWaiters = new Set<{
  resolve: () => void;
  reject: (error: Error) => void;
}>();
function waitForCore() {
  if (ready && core) return Promise.resolve();
  if (!core && restarts > 3)
    return Promise.reject(
      new Error("Core stopped. Reopen the app to reconnect persistent sessions."),
    );
  return new Promise<void>((resolve, reject) => {
    const waiter = {
      resolve: () => {
        clearTimeout(timer);
        readyWaiters.delete(waiter);
        resolve();
      },
      reject: (error: Error) => {
        clearTimeout(timer);
        readyWaiters.delete(waiter);
        reject(error);
      },
    };
    const timer = setTimeout(
      () => waiter.reject(new Error("Core startup timed out")),
      15000,
    );
    readyWaiters.add(waiter);
  });
}
let restarts = 0;
let requestId = 0;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
function event(value: CoreEvent) {
  if (window && !window.isDestroyed())
    window.webContents.send("workspace:event", value);
}
function startCore() {
  event({ type: "core.status", status: restarts ? "restarting" : "starting" });
  core = utilityProcess.fork(path.join(__dirname, "utility.mjs"), [], {
    env: {
      ...process.env,
      PATH: [
        ...new Set([
          ...(process.env.PATH || "").split(path.delimiter),
          path.join(os.homedir(), ".local/bin"),
          path.join(os.homedir(), ".npm-global/bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
        ]),
      ].join(path.delimiter),
      WORKSPACE_DATA_DIR: app.getPath("userData"),
    },
    serviceName: "Agent Workspace Core",
  });
  core.on("message", (message: any) => {
    if (message.type === "event") event(message.event);
    if (message.type === "closed") {
      shutdownComplete = true;
      app.quit();
    }
    if (message.type === "ready") {
      ready = true;
      for (const waiter of readyWaiters) waiter.resolve();
      event({ type: "core.status", status: "ready" });
    }
    if (message.type === "result") {
      const p = pending.get(message.id);
      if (p) {
        pending.delete(message.id);
        message.error
          ? p.reject(new Error(message.error))
          : p.resolve(message.result);
      }
    }
  });
  core.on("exit", () => {
    core = null;
    ready = false;
    for (const p of pending.values())
      p.reject(
        new Error(
          "Core connection interrupted; operation outcome may be unknown.",
        ),
      );
    pending.clear();
    if (!quitting && restarts++ < 3) setTimeout(startCore, 700 * restarts);
    else if (!quitting) {
      for (const waiter of readyWaiters)
        waiter.reject(
          new Error("Core stopped. Reopen the app to reconnect persistent sessions."),
        );
      event({
        type: "core.status",
        status: "failed",
        message:
          "Core stopped. Reopen the app to reconnect persistent sessions.",
      });
    }
  });
}
function createWindow() {
  window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: "#101214",
    title: "Agent Workspace",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.on("will-prevent-unload", (ev) => {
    const response = dialog.showMessageBoxSync(window!, {
      type: "question",
      buttons: ["Keep editing", "Discard"],
      defaultId: 0,
      cancelId: 0,
      title: "Unsaved changes",
      message: "Discard unsaved editor changes?",
      detail: "Your running terminal sessions will continue.",
    });
    if (response === 1) ev.preventDefault();
    else quitting = false;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (ev, url) => {
    if (url !== window?.webContents.getURL()) ev.preventDefault();
  });
  const dev = process.env.WORKSPACE_DEV_URL;
  if (dev) void window.loadURL(dev);
  else void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  window.on("closed", () => {
    window = null;
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (!window) createWindow();
    window?.show();
    window?.focus();
  });
  app.whenReady().then(() => {
    ipcMain.handle(
      "workspace:invoke",
      async (ev, command: unknown, payload: unknown = {}) => {
        if (
          ev.sender !== window?.webContents ||
          ev.senderFrame !== window?.webContents.mainFrame ||
          !COMMANDS.includes(command as any)
        )
          throw new Error("Unsupported workspace command");
        if (
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          JSON.stringify(payload).length > 2_000_000
        )
          throw new Error("Invalid payload");
        if (!ready) await waitForCore();
        if (!core) throw new Error("Core is reconnecting");
        const id = ++requestId;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(
              new Error(
                "Core request timed out; mutation outcome may be unknown. Inspect state before retrying.",
              ),
            );
          }, 60000);
          pending.set(id, {
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          });
          try {
            core!.postMessage({ type: "invoke", id, command, payload });
          } catch (error) {
            pending.delete(id);
            clearTimeout(timer);
            reject(error);
          }
        });
      },
    );
    ipcMain.handle("workspace:chooseDirectory", async (ev) => {
      if (
        ev.sender !== window?.webContents ||
        ev.senderFrame !== window?.webContents.mainFrame
      )
        throw new Error("Invalid sender");
      const result = await dialog.showOpenDialog(window!, {
        properties: ["openDirectory"],
      });
      return result.canceled ? null : result.filePaths[0];
    });
    startCore();
    createWindow();
    app.on("activate", () => {
      if (!window) createWindow();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", (ev) => {
    if (core && !shutdownComplete) {
      ev.preventDefault();
      if (!shutdownStarted) {
        shutdownStarted = true;
        // Let accepted editor/note writes finish before closing the database.
        // beforeunload protects changes that have not reached this bridge yet.
        void (async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          const deadline = Date.now() + 2000;
          while (pending.size && Date.now() < deadline)
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          try {
            core?.postMessage({ type: "shutdown" });
          } catch {
            shutdownComplete = true;
            app.quit();
          }
        })();
        setTimeout(() => {
          shutdownComplete = true;
          app.quit();
        }, 6000).unref();
      }
    }
  });
}
