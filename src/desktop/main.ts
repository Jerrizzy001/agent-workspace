import { deltaReceiver } from "../shared/deltas";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  screen,
  session,
  shell,
  utilityProcess,
} from "electron";
import { createTeamDesktop, electronSecretStore } from "./team";
import path from "node:path";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { createSecureContext } from "node:tls";
import { startGateway, type Gateway } from "../server/gateway";
import { listDirectory, loginShellPath } from "./folders";
import {
  discardClipboardImage,
  previewClipboardImage,
  takeClipboardImage,
} from "./clipboard-images";
import type { MenuAction } from "../shared/contracts";
import { createPowerController } from "./power";
import {
  restoreBounds,
  WINDOW_MIN,
  windowStateFile,
  type WindowBounds,
} from "./window-state";
import { createDictationService, defaultModelsDir } from "./dictation";
import type { PowerPolicy } from "./power-policy";
import { assistOnlyThroughChannel, handleAssist } from "./assist";
import {
  COMMANDS,
  type Command,
  type CoreEvent,
  type PowerStatus,
  type RemoteConfig,
  type RemoteStatus,
  type Snapshot,
} from "../shared/contracts";
let window: BrowserWindow | null = null;
let core: Electron.UtilityProcess | null = null;
if (process.env.WORKSPACE_TEST_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.WORKSPACE_TEST_DATA_DIR));
// Test-only: Chromium's fake capture device plays a WAV file as the microphone.
// "use-fake-ui-for-media-stream" is deliberately not set: it would grant
// capture without consulting the permission handlers that tests verify.
if (process.env.WORKSPACE_TEST_FAKE_MIC) {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch(
    "use-file-for-fake-audio-capture",
    path.resolve(process.env.WORKSPACE_TEST_FAKE_MIC) + "%noloop",
  );
}
// Test-only: Electron's unencrypted "basic" secret store for team sign-in,
// because headless Linux test machines have no unlocked keyring. Production
// refuses that store (team sign-in fails closed).
const teamTestBasicStore =
  !!process.env.WORKSPACE_TEST_DATA_DIR &&
  process.env.WORKSPACE_TEST_TEAM_BASIC_SECRET_STORE === "1";
if (teamTestBasicStore) app.commandLine.appendSwitch("password-store", "basic");
let team: ReturnType<typeof createTeamDesktop> | null = null;
let quitting = false;
let ready = false;
let shutdownComplete = false;
let shutdownStarted = false;
let gateway: Gateway | null = null;
let gatewayMutation = false;
let sharedProjects: RemoteStatus["sharedProjects"] = [];
let remoteConfig: RemoteConfig = { host: "127.0.0.1", port: 4318, tls: false };
let certificatePath = "";
let keyPath = "";
let coreStatus: RemoteStatus["coreStatus"] = "starting";
const eventListeners = new Set<(event: CoreEvent) => void>();
// Keep-awake demand is derived here from core snapshots only, never from renderer state.
let power: PowerPolicy | null = null;
let dictation: ReturnType<typeof createDictationService> | null = null;
let snapshotsSeen = 0;
let powerWrites = 0;
function powerStatus(status: PowerStatus) {
  if (window && !window.isDestroyed())
    window.webContents.send("workspace:power", status);
}
/** After (re)connecting to the core, load the owner preference and current sessions. */
async function syncPower() {
  const seen = snapshotsSeen,
    writes = powerWrites;
  try {
    const [setting, snapshot] = await Promise.all([
      invokeCore("settings.read", { key: "keepAwake" }) as Promise<{
        value: unknown;
      }>,
      invokeCore("snapshot") as Promise<Snapshot>,
    ]);
    if (!power || !core || !ready) return;
    if (writes === powerWrites) power.setEnabled(setting.value === true);
    if (seen === snapshotsSeen)
      power.setSessions(snapshot.sessions.filter((s) => !s.hostId));
  } catch {
    /* A later snapshot event or reconnect will resynchronize. */
  }
}
function remoteStatus(): RemoteStatus {
  const live = gateway?.status();
  const host = remoteConfig.host;
  return {
    enabled: !!gateway,
    host,
    port: live?.port ?? remoteConfig.port,
    url: live?.url || "",
    publicOrigin: remoteConfig.publicOrigin,
    tls: remoteConfig.tls,
    coreStatus,
    sharedProjects,
    certificateName: certificatePath
      ? path.basename(certificatePath)
      : undefined,
    keyName: keyPath ? path.basename(keyPath) : undefined,
  };
}
/** The app window's own renderer page (file or dev server), never another origin. */
function trustedFrame(
  contents: Electron.WebContents | null,
  url: string | undefined,
  mainFrame: boolean,
) {
  if (
    !window ||
    window.isDestroyed() ||
    contents !== window.webContents ||
    !mainFrame ||
    !url
  )
    return false;
  const dev = process.env.WORKSPACE_DEV_URL;
  try {
    const parsed = new URL(url);
    if (dev) return parsed.origin === new URL(dev).origin;
    return parsed.protocol === "file:";
  } catch {
    return false;
  }
}
/**
 * Permissions: the app window's main frame may capture audio (dictation),
 * show notifications and write the clipboard. Video, screen capture, other
 * frames, other windows and every other permission are denied.
 */
function installPermissionPolicy() {
  const allowed = (
    contents: Electron.WebContents | null,
    permission: string,
    url: string | undefined,
    mainFrame: boolean,
    mediaTypes: string[] | undefined,
  ) => {
    if (!trustedFrame(contents, url, mainFrame)) return false;
    if (permission === "media")
      return (
        !!mediaTypes?.length && mediaTypes.every((type) => type === "audio")
      );
    return (
      permission === "notifications" ||
      permission === "clipboard-sanitized-write"
    );
  };
  session.defaultSession.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      const media =
        permission === "media"
          ? (details as Electron.MediaAccessPermissionRequest).mediaTypes
          : undefined;
      callback(
        allowed(
          contents,
          permission,
          details.requestingUrl,
          details.isMainFrame,
          media,
        ),
      );
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission, origin, details) => {
      const media =
        permission === "media"
          ? [
              details.mediaType === "audio"
                ? "audio"
                : details.mediaType || "unknown",
            ]
          : undefined;
      return allowed(
        contents,
        permission,
        details.requestingUrl || origin,
        details.isMainFrame,
        media,
      );
    },
  );
}
function assertOwner(ev: Electron.IpcMainInvokeEvent) {
  if (
    ev.sender !== window?.webContents ||
    ev.senderFrame !== window?.webContents.mainFrame
  )
    throw new Error("Invalid sender");
}
function validatePayload(
  command: unknown,
  payload: unknown,
): asserts command is Command {
  if (!COMMANDS.includes(command as Command))
    throw new Error("Unsupported workspace command");
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    JSON.stringify(payload).length > 2_000_000
  )
    throw new Error("Invalid payload");
}
async function invokeCore(
  command: Command,
  payload: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<unknown> {
  validatePayload(command, payload);
  return coreRequest(
    { type: "invoke", command, payload },
    timeoutMs ?? (command === "git.commit" ? 180_000 : 90_000),
  );
}
/** Internal requests (invoke, attachment) share one result channel and timeout. */
async function coreRequest(
  message: Record<string, unknown>,
  timeoutMs = 60000,
): Promise<unknown> {
  if (quitting) throw new Error("Workspace is shutting down");
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
    }, timeoutMs);
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
      core!.postMessage({ ...message, id });
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}
const readyWaiters = new Set<{
  resolve: () => void;
  reject: (error: Error) => void;
}>();
function waitForCore() {
  if (ready && core) return Promise.resolve();
  if (!core && restarts > 3)
    return Promise.reject(
      new Error(
        "Core stopped. Reopen the app to reconnect persistent sessions.",
      ),
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
let stableCoreTimer: ReturnType<typeof setTimeout> | undefined;
const receiveCore = deltaReceiver();
let requestId = 0;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
function event(value: CoreEvent) {
  if (value.type === "core.status") coreStatus = value.status;
  const materialized = receiveCore.accept(value);
  if (materialized?.type === "snapshot") {
    snapshotsSeen++;
    // Only local sessions keep this computer awake; SSH hosts are not covered.
    power?.setSessions(materialized.snapshot.sessions.filter((s) => !s.hostId));
  }
  for (const listener of eventListeners) {
    try {
      listener(value);
    } catch {
      /* A detached browser must not disrupt the core. */
    }
  }
  if (window && !window.isDestroyed())
    window.webContents.send("workspace:event", value);
}
let corePath = process.env.PATH || "";
/** Provider CLIs are found through the user's login-shell PATH plus common install folders. */
async function resolveCorePath() {
  const login = await loginShellPath();
  corePath = [
    ...new Set(
      [
        ...(process.env.PATH || "").split(path.delimiter),
        ...login.split(path.delimiter),
        path.join(os.homedir(), ".local/bin"),
        path.join(os.homedir(), ".npm-global/bin"),
        path.join(os.homedir(), ".volta/bin"),
        path.join(os.homedir(), ".bun/bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ].filter((entry) => entry && path.isAbsolute(entry)),
    ),
  ].join(path.delimiter);
}
function startCore() {
  event({ type: "core.status", status: restarts ? "restarting" : "starting" });
  core = utilityProcess.fork(path.join(__dirname, "utility.mjs"), [], {
    env: {
      ...process.env,
      PATH: corePath,
      WORKSPACE_DATA_DIR: app.getPath("userData"),
      // awctl for agent control, run by this app's own binary as Node. A
      // packaged app keeps the script outside the asar archive.
      WORKSPACE_AWCTL: path
        .join(__dirname, "../cli/awctl.mjs")
        .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`),
      WORKSPACE_AWCTL_NODE: process.execPath,
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
      clearTimeout(stableCoreTimer);
      stableCoreTimer = setTimeout(() => {
        restarts = 0;
      }, 60_000);
      stableCoreTimer.unref();
      for (const waiter of readyWaiters) waiter.resolve();
      event({ type: "core.status", status: "ready" });
      void syncPower();
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
    clearTimeout(stableCoreTimer);
    core = null;
    ready = false;
    // Without the core nothing proves an agent is working.
    power?.setSessions(null);
    if (!quitting)
      event({
        type: "core.status",
        status: restarts < 3 ? "restarting" : "failed",
      });
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
          new Error(
            "Core stopped. Reopen the app to reconnect persistent sessions.",
          ),
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
let pendingMenu: MenuAction | undefined;
function buildMenu() {
  app.setAboutPanelOptions({
    applicationName: "Agent Workspace",
    credits:
      "Built with Electron, React, React Flow (xyflow, MIT), xterm.js (MIT), " +
      "Monaco Editor (MIT), sherpa-onnx (Apache-2.0), ONNX Runtime (MIT), " +
      "Lucide icons (ISC) and node-qrcode (MIT).",
  });
  const send = (action: MenuAction) => () => {
    // A window that is still loading has no listener yet: hold the action
    // until its renderer reports that it subscribed.
    if (!window) {
      pendingMenu = action;
      createWindow();
    } else if (window.webContents.isLoading()) pendingMenu = action;
    else window.webContents.send("workspace:menu", action);
  };
  ipcMain.on("workspace:menu-ready", (ev) => {
    if (ev.sender !== window?.webContents || !pendingMenu) return;
    ev.sender.send("workspace:menu", pendingMenu);
    pendingMenu = undefined;
  });
  // Shortcuts the renderer already handles are shown, not re-registered, so
  // the terminal keeps receiving them where it should.
  const shown = (accelerator: string) => ({
    accelerator,
    registerAccelerator: false,
  });
  const mac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: send("settings"),
              },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Folder…",
          ...shown("CmdOrCtrl+O"),
          click: send("open-folder"),
        },
        { label: "New Task", ...shown("CmdOrCtrl+N"), click: send("new-task") },
        { type: "separator" },
        ...(mac
          ? [{ role: "close" as const }]
          : [
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: send("settings"),
              },
              { role: "quit" as const },
            ]),
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Command Palette…",
          ...shown("CmdOrCtrl+K"),
          click: send("palette"),
        },
        { type: "separator" },
        { label: "Terminals", click: send("view-terminals") },
        { label: "Board", click: send("view-board") },
        { label: "Canvas", click: send("view-canvas") },
        { type: "separator" },
        { label: "Toggle Folders and Sessions", click: send("toggle-sidebar") },
        { label: "Toggle Files and Changes", click: send("toggle-files") },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }]),
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
let windowState: ReturnType<typeof windowStateFile> | undefined;
function createWindow() {
  windowState ??= windowStateFile(app.getPath("userData"));
  const bounds = restoreBounds(
    windowState.read(),
    screen.getAllDisplays().map((d) => d.workArea),
  );
  window = new BrowserWindow({
    ...(bounds.x !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    width: bounds.width,
    height: bounds.height,
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    backgroundColor: "#0b0d12",
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
  // Text fields and the terminal (its hidden textarea is editable) get the
  // standard edit menu. Rows with their own menus cancel the DOM event first,
  // so this only runs where the renderer did not handle the right-click.
  window.webContents.on("context-menu", (_ev, params) => {
    const flags = params.editFlags;
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      for (const word of params.dictionarySuggestions.slice(0, 4))
        template.push({
          label: word,
          click: () => window?.webContents.replaceMisspelling(word),
        });
      if (template.length) template.push({ type: "separator" });
      template.push(
        { role: "cut", enabled: flags.canCut },
        { role: "copy", enabled: flags.canCopy },
        { role: "paste", enabled: flags.canPaste },
        { type: "separator" },
        { role: "selectAll", enabled: flags.canSelectAll },
      );
    } else if (params.selectionText.trim())
      template.push({ role: "copy" }, { role: "selectAll" });
    if (template.length)
      Menu.buildFromTemplate(template).popup({ window: window! });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (ev, url) => {
    if (url !== window?.webContents.getURL()) ev.preventDefault();
  });
  const dev = process.env.WORKSPACE_DEV_URL;
  if (dev) void window.loadURL(dev);
  else void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  if (bounds.maximized) window.maximize();
  // Remember size and place (not while full screen) for the next launch.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const saveBounds = () => {
    const w = window;
    if (!w || w.isDestroyed() || w.isFullScreen() || w.isMinimized()) return;
    const b = w.isMaximized() ? w.getNormalBounds() : w.getBounds();
    const next: WindowBounds = { ...b, maximized: w.isMaximized() };
    try {
      windowState?.write(next);
    } catch {}
  };
  const queueSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBounds, 400);
  };
  for (const name of ["resize", "move", "maximize", "unmaximize"] as const)
    window.on(name as "resize", queueSave);
  window.on("close", () => {
    clearTimeout(saveTimer);
    saveBounds();
  });
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
    ipcMain.handle("workspace:sync", async (ev) => {
      assertOwner(ev);
      const snapshot = await invokeCore("snapshot");
      return receiveCore.current() ?? { type: "snapshot", snapshot };
    });
    ipcMain.handle(
      "workspace:invoke",
      async (ev, command: unknown, payload: unknown = {}) => {
        // Only the active local window's main frame may cross this IPC boundary.
        if (
          ev.sender !== window?.webContents ||
          ev.senderFrame !== window?.webContents.mainFrame
        )
          throw new Error("Unsupported workspace command");
        validatePayload(command, payload);
        // The keep-awake preference changes only through workspace:power so the
        // main process's blocker policy always matches what is stored.
        if (
          command === "settings.write" &&
          (payload as Record<string, unknown>).key === "keepAwake"
        )
          throw new Error("Change keep-awake through the power settings");
        // AI suggestions and their consent go only through workspace:assist.
        if (
          assistOnlyThroughChannel(command, payload as Record<string, unknown>)
        )
          throw new Error("Use the AI suggestions controls for this");
        return invokeCore(command, payload as Record<string, unknown>);
      },
    );
    ipcMain.handle(
      "workspace:assist",
      async (ev, action: unknown, value: unknown) => {
        // Owner window only: suggestions spend the owner's provider usage and
        // have no route through the gateway or any other frame.
        assertOwner(ev);
        return handleAssist(invokeCore, action, value);
      },
    );
    ipcMain.handle("workspace:contextMenu", (ev, items: unknown) => {
      assertOwner(ev);
      if (!Array.isArray(items) || !items.length || items.length > 30)
        throw new Error("Invalid menu");
      return new Promise<string | null>((resolve) => {
        let chosen: string | null = null;
        const template = items.map(
          (item): Electron.MenuItemConstructorOptions => {
            if (item?.type === "separator") return { type: "separator" };
            if (
              typeof item?.id !== "string" ||
              typeof item?.label !== "string" ||
              item.label.length > 200
            )
              throw new Error("Invalid menu item");
            return {
              label: item.label,
              enabled: item.enabled !== false,
              click: () => {
                chosen = item.id;
              },
            };
          },
        );
        Menu.buildFromTemplate(template).popup({
          window: window!,
          // Clicks run before close, so `chosen` is set when this fires.
          callback: () => setImmediate(() => resolve(chosen)),
        });
      });
    });
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
    ipcMain.handle("workspace:browse", async (ev, target: unknown) => {
      // Host-wide navigation is an owner capability of this window only; the
      // remote gateway has no route to it.
      assertOwner(ev);
      return listDirectory(target);
    });
    ipcMain.handle(
      "workspace:clipboardImage",
      async (ev, action: unknown, value: unknown) => {
        // Owner window only: the gateway and remote browsers have no route here,
        // and image bytes reach the core over a dedicated internal message.
        assertOwner(ev);
        if (action === "preview") return previewClipboardImage();
        if (action === "discard") return discardClipboardImage(value);
        if (action !== "save")
          throw new Error("Unsupported clipboard image action");
        const v = value as Record<string, unknown>;
        if (
          !v ||
          typeof v !== "object" ||
          Array.isArray(v) ||
          Object.keys(v).some(
            (key) => !["token", "sessionId", "generation"].includes(key),
          ) ||
          typeof v.sessionId !== "string" ||
          !v.sessionId ||
          v.sessionId.length > 128 ||
          !Number.isSafeInteger(v.generation) ||
          Number(v.generation) < 1
        )
          throw new Error("Invalid image save request");
        const png = takeClipboardImage(v.token);
        return coreRequest({
          type: "attachment",
          sessionId: v.sessionId,
          generation: v.generation,
          data: png,
        });
      },
    );
    ipcMain.handle(
      "workspace:ssh",
      async (ev, action: unknown, value: unknown) => {
        // Owner window only: SSH hosts, host keys and remote folder registration
        // never reach the gateway, a paired browser or an agent.
        assertOwner(ev);
        if (
          ![
            "list",
            "add",
            "probe",
            "connect",
            "disconnect",
            "browse",
            "registerProject",
            "remove",
          ].includes(action as string)
        )
          throw new Error("Unsupported SSH action");
        if (value === undefined) value = {};
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          JSON.stringify(value).length > 8192
        )
          throw new Error("Invalid SSH request");
        return coreRequest({ type: "ssh", action, payload: value }, 120000);
      },
    );
    ipcMain.handle(
      "workspace:agent-control",
      async (ev, action: unknown, value: unknown) => {
        // Owner window only: neither the remote gateway nor an agent's awctl
        // capability can reach this, so neither can mint or widen a grant.
        assertOwner(ev);
        if (
          action !== "grant" &&
          action !== "revoke" &&
          action !== "list" &&
          action !== "allowTranscript"
        )
          throw new Error("Unsupported agent control action");
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          JSON.stringify(value).length > 4096
        )
          throw new Error("Invalid agent control request");
        return coreRequest({ type: "agentControl", action, payload: value });
      },
    );
    ipcMain.handle(
      "workspace:profiles",
      async (ev, action: unknown, value: unknown) => {
        // Owner window only: Claude profiles (private config folders and the
        // sign-in terminal) never reach the gateway, a browser or an agent.
        assertOwner(ev);
        if (
          !["list", "create", "setup", "check", "remove", "account"].includes(
            action as string,
          )
        )
          throw new Error("Unsupported profile action");
        if (value === undefined) value = {};
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          JSON.stringify(value).length > 4096
        )
          throw new Error("Invalid profile request");
        return coreRequest({ type: "profiles", action, payload: value });
      },
    );
    team = createTeamDesktop({
      store: (action, payload = {}) =>
        coreRequest({ type: "team", action, payload }) as Promise<any>,
      secrets: electronSecretStore(
        safeStorage,
        path.join(app.getPath("userData"), "team-session.bin"),
        teamTestBasicStore,
      ),
      openUrl: async (url) => {
        // Test-only: fetch the issuer's auto-approving page instead of a browser.
        if (
          process.env.WORKSPACE_TEST_DATA_DIR &&
          process.env.WORKSPACE_TEST_TEAM_AUTOBROWSER === "1"
        ) {
          const u = new URL(url);
          if (process.env.WORKSPACE_TEST_TEAM_LOGIN_HINT)
            u.searchParams.set(
              "login_hint",
              process.env.WORKSPACE_TEST_TEAM_LOGIN_HINT,
            );
          await fetch(u);
          return;
        }
        // The system browser: the app never shows an identity provider's form itself.
        await shell.openExternal(url);
      },
      emit: () => {
        if (window && !window.isDestroyed())
          window.webContents.send("workspace:team", { type: "changed" });
      },
      syncIntervalMs:
        Number(process.env.WORKSPACE_TEST_TEAM_SYNC_MS) || undefined,
    });
    ipcMain.handle(
      "workspace:team",
      async (ev, action: unknown, value: unknown) => {
        // Owner window only. Team tokens live in this process and go only to the
        // team service; the gateway, paired browsers and agents have no route here.
        assertOwner(ev);
        if (!team) throw new Error("Team features are unavailable");
        return team.handle(action, value);
      },
    );
    installPermissionPolicy();
    dictation = createDictationService({
      modelsDir: defaultModelsDir(app.getPath("userData")),
      engine:
        process.env.WORKSPACE_TEST_DICTATION_TEXT !== undefined
          ? "fixture"
          : "sherpa-onnx",
      fork: () =>
        utilityProcess.fork(path.join(__dirname, "dictation-worker.mjs"), [], {
          serviceName: "Agent Workspace Dictation",
          // Only what the worker needs: no core paths or provider settings.
          env: {
            PATH: process.env.PATH || "",
            ...(process.env.WORKSPACE_TEST_DICTATION_TEXT !== undefined
              ? {
                  WORKSPACE_TEST_DICTATION_TEXT:
                    process.env.WORKSPACE_TEST_DICTATION_TEXT,
                }
              : {}),
            ...(process.env.WORKSPACE_TEST_DICTATION_ARCHIVE
              ? {
                  WORKSPACE_TEST_DICTATION_ARCHIVE:
                    process.env.WORKSPACE_TEST_DICTATION_ARCHIVE,
                }
              : {}),
          },
        }),
      readModel: async () =>
        (
          (await invokeCore("settings.read", { key: "dictationModel" })) as {
            value: unknown;
          }
        ).value,
      emit: (status) => {
        if (window && !window.isDestroyed())
          window.webContents.send("workspace:dictation", status);
      },
    });
    ipcMain.handle(
      "workspace:dictation",
      async (ev, action: unknown, value: unknown) => {
        // Owner window only: microphone audio never crosses the gateway, and
        // speech-to-text runs in a local utility process.
        assertOwner(ev);
        if (!dictation) throw new Error("Dictation is unavailable");
        const fields = (keys: string[]) => {
          const v = value as Record<string, unknown>;
          if (
            !v ||
            typeof v !== "object" ||
            Array.isArray(v) ||
            Object.keys(v).some((k) => !keys.includes(k))
          )
            throw new Error("Invalid dictation request");
          return v;
        };
        if (action === "status") return dictation.status();
        if (action === "downloadModel")
          return dictation.downloadModel(fields(["modelId"]).modelId);
        if (action === "start") return dictation.start();
        if (action === "phrase") return dictation.phrase(value);
        if (action === "stop")
          return dictation.stop(fields(["recordingId"]).recordingId);
        throw new Error("Unsupported dictation action");
      },
    );
    power = createPowerController(powerStatus);
    ipcMain.handle(
      "workspace:power",
      async (ev, action: unknown, value: unknown) => {
        assertOwner(ev);
        if (!power) throw new Error("Power management is unavailable");
        if (action === "status") return power.status();
        if (action !== "setEnabled")
          throw new Error("Unsupported power action");
        if (typeof value !== "boolean")
          throw new Error("Invalid power setting");
        powerWrites++;
        await invokeCore("settings.write", { key: "keepAwake", value });
        power.setEnabled(value);
        return power.status();
      },
    );
    ipcMain.handle(
      "workspace:remote",
      async (ev, action: unknown, value: unknown) => {
        assertOwner(ev);
        if (action === "status") return remoteStatus();
        if (action === "pairingSecret") {
          if (!gateway) throw new Error("Enable remote access first");
          return gateway.pairingSecret();
        }
        if (action === "pairingLink") {
          if (!gateway) throw new Error("Enable remote access first");
          return gateway.pairingLink();
        }
        if (action === "pairingLinkPending")
          return (
            typeof value === "string" && !!gateway?.pairingLinkPending(value)
          );
        if (action === "revokeSessions") {
          if (!gateway) throw new Error("Remote access is stopped");
          await gateway.revokeSessions();
          return;
        }
        if (gatewayMutation)
          throw new Error("Remote access is changing; try again shortly");
        gatewayMutation = true;
        try {
          if (action === "chooseTLSFile") {
            if (value !== "certificate" && value !== "key")
              throw new Error("Invalid TLS file kind");
            const result = await dialog.showOpenDialog(window!, {
              title:
                value === "certificate"
                  ? "Choose TLS certificate (PEM)"
                  : "Choose TLS private key (PEM)",
              properties: ["openFile"],
              filters: [
                {
                  name: "PEM files",
                  extensions: ["pem", "crt", "key", "cert"],
                },
              ],
            });
            if (!result.canceled) {
              if (value === "certificate")
                certificatePath = result.filePaths[0];
              else keyPath = result.filePaths[0];
            }
            return remoteStatus();
          }
          if (action === "disable") {
            if (gateway) await gateway.stop();
            gateway = null;
            return remoteStatus();
          }
          if (action !== "enable")
            throw new Error("Unsupported remote management action");
          if (gateway)
            throw new Error("Stop remote access before changing its settings");
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("Invalid remote settings");
          const v = value as Record<string, unknown>;
          if (
            Object.keys(v).some(
              (key) =>
                !["host", "port", "publicOrigin", "tls", "projectIds"].includes(
                  key,
                ),
            ) ||
            typeof v.host !== "string" ||
            !v.host ||
            v.host.length > 255 ||
            !Number.isSafeInteger(v.port) ||
            Number(v.port) < 0 ||
            Number(v.port) > 65535 ||
            typeof v.tls !== "boolean" ||
            (v.publicOrigin !== undefined && typeof v.publicOrigin !== "string")
          )
            throw new Error("Invalid remote settings");
          const config = {
            host: v.host,
            port: Number(v.port),
            tls: v.tls,
            publicOrigin: v.publicOrigin || undefined,
          } as RemoteConfig;
          const loopback =
            config.host === "127.0.0.1" ||
            config.host === "::1" ||
            config.host === "localhost";
          if (!loopback && !config.tls)
            throw new Error(
              "A network listener requires TLS. Choose a certificate and key, or keep loopback for a secure tunnel.",
            );
          if (!loopback && !config.publicOrigin)
            throw new Error(
              "Enter the HTTPS browser address matching your certificate for network access",
            );
          if (config.publicOrigin) {
            const url = new URL(config.publicOrigin);
            if (
              (url.protocol !== "https:" &&
                !(
                  loopback &&
                  url.protocol === "http:" &&
                  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
                )) ||
              url.username ||
              url.password ||
              url.search ||
              url.hash ||
              url.pathname !== "/"
            )
              throw new Error(
                "Public address must be an HTTPS origin without a path, query or credentials",
              );
            config.publicOrigin = url.origin;
          }
          let tls;
          if (config.tls) {
            if (!certificatePath || !keyPath)
              throw new Error("Choose a TLS certificate and private key first");
            const [cert, key] = await Promise.all([
              readFile(certificatePath),
              readFile(keyPath),
            ]);
            if (cert.length > 1024 * 1024 || key.length > 1024 * 1024)
              throw new Error("TLS file is too large");
            createSecureContext({ cert, key });
            tls = { cert, key };
          }
          await waitForCore();
          const sharing = (await invokeCore(
            "snapshot",
          )) as import("../shared/contracts").Snapshot;
          // SSH folders are never shared with browsers by default.
          if (
            !Array.isArray(v.projectIds) ||
            !v.projectIds.length ||
            v.projectIds.length > 1000 ||
            v.projectIds.some((x) => typeof x !== "string")
          )
            throw new Error(
              "Choose the folders to share before enabling remote access",
            );
          const chosen = new Set(v.projectIds);
          const shared = sharing.projects.filter(
            (p) => !p.hostId && !p.hidden && chosen.has(p.id),
          );
          if (shared.length !== chosen.size)
            throw new Error(
              "A selected folder is unavailable. Review the sharing selection.",
            );
          if (!shared.length)
            throw new Error("Open a project before enabling remote access");
          const started = await startGateway({
            dataDir: app.getPath("userData"),
            invoke: invokeCore,
            allowedProjectIds: shared.map((p) => p.id),
            subscribe: (listener) => {
              eventListeners.add(listener);
              return () => {
                eventListeners.delete(listener);
              };
            },
            host: config.host,
            port: config.port,
            tls,
            publicOrigin: config.publicOrigin,
            staticDir: path.join(__dirname, "../renderer"),
          });
          if (quitting) {
            await started.stop();
            throw new Error("Workspace is shutting down");
          }
          remoteConfig = config;
          sharedProjects = shared.map((p) => ({ id: p.id, name: p.name }));
          gateway = started;
          return remoteStatus();
        } finally {
          gatewayMutation = false;
        }
      },
    );
    void resolveCorePath().finally(startCore);
    buildMenu();
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
    // Quitting releases the blocker even though tmux sessions keep running.
    power?.dispose();
    dictation?.dispose();
    team?.dispose();
    if ((core || gateway) && !shutdownComplete) {
      ev.preventDefault();
      if (!shutdownStarted) {
        shutdownStarted = true;
        // Let accepted editor/note writes finish before closing the database.
        // beforeunload protects changes that have not reached this bridge yet.
        void (async () => {
          // Close HTTP/WS clients before closing the one shared utility core.
          if (gateway) {
            await gateway.stop();
            gateway = null;
          }
          if (!core) {
            shutdownComplete = true;
            app.quit();
            return;
          }
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
