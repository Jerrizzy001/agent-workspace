import { WorkspaceDataPanel } from "./WorkspaceDataPanel";
import { createId } from "./id";
import { endSession } from "./session-actions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  ChevronDown,
  Ellipsis,
  FileText,
  Files,
  FolderOpen,
  FolderPlus,
  KeyRound,
  LayoutGrid,
  Menu,
  Mic,
  Sparkles,
  Network,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  PanelRightClose,
  Plus,
  RefreshCw,
  Search,
  Server,
  Smartphone,
  Users,
  SquareTerminal,
  SunMoon,
  X,
  GitBranch,
  Database,
  Moon,
  Settings as SettingsIcon,
} from "lucide-react";
import type {
  ExecutionHostView,
  MenuAction,
  PowerStatus,
  Project,
  Provider,
  Session,
  Snapshot,
  Task,
} from "../shared/contracts";
import { ReviewPanel, type ReviewSummary } from "./ReviewPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { CanvasView } from "./CanvasView";
import { RemoteAccessPanel } from "./RemoteAccessPanel";
import { SSHProjectsPanel, hostStateLabel } from "./SSHProjectsPanel";
import { TeamPanel } from "./TeamPanel";
import { FolderBrowser } from "./FolderBrowser";
import { LaunchBar, savedModels, type LaunchChoices } from "./LaunchBar";
import { SessionView } from "./SessionView";
import {
  ProfilesPanel,
  profileLabel,
  profilesAvailable,
  refreshProfiles,
  useProfiles,
} from "./ProfilesPanel";
import { AttemptModal, Board, TaskModal, statusLabel } from "./Board";
import { SessionBoard } from "./SessionBoard";
import { isRemoteBrowser } from "./remote";
import { DictationNotices, DictationSettings } from "./DictationControl";
import { AssistSettings, assistAvailable, openAssistSettings } from "./assist";
import { dictationAvailable, openDictationSettings } from "./dictation";
import { registerLeaveGuard } from "./leaveWorkspace";
import { mergeSnapshot } from "./snapshot";
import { paletteMatches } from "./palette-search";
import { FirstRunChecklist, installHints } from "./FirstRunChecklist";
import {
  SettingsRow,
  hostsState,
  useProfilesState,
  useSettingsStates,
} from "./settings-state";
import {
  capability,
  errorText,
  isOpen,
  orderSessions,
  providerName,
  providers,
  sessionLocation,
  sessionState,
  sessionTitle,
} from "./sessions";
import { BrandMark, ProviderGlyph, StatusBadge } from "./ui";
import { AppearanceSettings } from "./AppearanceSettings";

const initial: Snapshot = {
  projects: [],
  tasks: [],
  attempts: [],
  sessions: [],
  notes: [],
  layouts: [],
  boardLanes: [],
  capabilities: [],
};
const isMac = /Mac|iPhone|iPad/i.test(
  navigator.platform || navigator.userAgent,
);
const modKey = isMac ? "⌘" : "Ctrl";
function stored(key: string, fallback = "") {
  try {
    return localStorage.getItem("workspace.selection." + key) ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem("workspace.selection." + key, value);
  } catch {
    /* Selection persistence is optional; credentials are never stored here. */
  }
}
type View = "terminals" | "board" | "canvas";
type BoardMode = "sessions" | "tasks";
type LaunchProblem = {
  provider: Provider;
  message: string;
  kind: "missing" | "uncertain" | "error";
  retry?: { key: string; payload: Record<string, unknown> };
};
type Toast = {
  id: string;
  sessionId: string;
  title: string;
  detail: string;
  tone: string;
};

export default function App() {
  const [snapshot, setSnapshot] = useState(initial);
  const [core, setCore] = useState("starting");
  const [error, setError] = useState("");
  const [projectId, setProjectId] = useState(() => stored("project"));
  const [sessionId, setSessionId] = useState(() => stored("session"));
  const [taskId, setTaskId] = useState("");
  const [modalTask, setModalTask] = useState<Task | undefined>();
  const [view, setView] = useState<View>("terminals");
  const [boardMode, setBoardMode] = useState<BoardMode>(() =>
    stored("board") === "tasks" ? "tasks" : "sessions",
  );
  const [browsing, setBrowsing] = useState(false);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<LaunchChoices>(() => ({
    models: savedModels(),
    prompt: "",
    worktreePath: "",
    profileId: "",
  }));
  const profiles = useProfiles();
  const [profilesPanel, setProfilesPanel] = useState(false);
  useEffect(() => {
    if (profilesAvailable()) void refreshProfiles();
  }, [snapshot.sessions.length]);
  const [launching, setLaunching] = useState<Provider | null>(null);
  const [problem, setProblem] = useState<LaunchProblem | null>(null);
  const [git, setGit] = useState<ReviewSummary | null>(null);
  const [filesOpen, setFilesOpen] = useState(
    () => stored("files", "1") !== "0",
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => stored("sidebar") === "collapsed",
  );
  const sidebarRestore = useRef<HTMLButtonElement>(null);
  const sidebarCollapse = useRef<HTMLButtonElement>(null);
  const filesToggle = useRef<HTMLButtonElement>(null);
  const mobileFiles = useRef<HTMLButtonElement>(null);
  const toggleSidebar = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    requestAnimationFrame(() =>
      (collapsed ? sidebarRestore : sidebarCollapse).current?.focus(),
    );
  };
  const collapseFiles = () => {
    setFilesOpen(false);
    setMobilePane("terminal");
    requestAnimationFrame(() => {
      (window.matchMedia("(min-width: 901px)").matches
        ? filesToggle
        : mobileFiles
      ).current?.focus();
    });
  };
  const [drawer, setDrawer] = useState(false);
  const drawerPanel = useRef<HTMLElement>(null);
  // On narrow layouts the open drawer covers the page: focus moves into it,
  // the page behind is inert, Escape closes it and focus goes back.
  useEffect(() => {
    if (!drawer) return;
    const narrow = window.matchMedia("(max-width: 900px)");
    const panel = drawerPanel.current;
    if (!narrow.matches || !panel) {
      setDrawer(false);
      return;
    }
    const opener = document.activeElement as HTMLElement | null;
    const behind = [...(panel.parentElement?.children || [])].filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement &&
        el !== panel &&
        !el.classList.contains("drawer-scrim"),
    );
    const was = behind.map((el) => el.inert);
    for (const el of behind) el.inert = true;
    panel.querySelector<HTMLElement>(".drawer-close")?.focus();
    const key = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        document.querySelector('[role="dialog"][aria-modal="true"]')
      )
        return;
      event.preventDefault();
      setDrawer(false);
    };
    const widened = () => !narrow.matches && setDrawer(false);
    window.addEventListener("keydown", key);
    narrow.addEventListener("change", widened);
    return () => {
      window.removeEventListener("keydown", key);
      narrow.removeEventListener("change", widened);
      behind.forEach((el, i) => (el.inert = was[i]!));
      if (opener?.isConnected && !panel.contains(opener)) opener.focus();
    };
  }, [drawer]);
  const [mobilePane, setMobilePane] = useState<"terminal" | "files">(
    "terminal",
  );
  const [modal, setModal] = useState<
    "task" | "edit-task" | "attempt" | "palette" | null
  >(null);
  const [settingsPanel, setSettingsPanel] = useState(false);
  const [dataPanel, setDataPanel] = useState(false);
  const [handoffDraft, setHandoffDraft] = useState<{
    sessionId: string;
    generation: number;
    text: string;
  } | null>(null);
  const [connectRequested, setConnectRequested] = useState(false);
  const [remotePanel, setRemotePanel] = useState(false);
  const [sshPanel, setSSHPanel] = useState(false);
  const [teamPanel, setTeamPanel] = useState(false);
  const [folderMenu, setFolderMenu] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [reviewOverride, setReviewOverride] = useState<string | null>(null);
  const [reviewRefresh, setReviewRefresh] = useState(0);
  const [editorDirty, setEditorDirty] = useState(false);
  const canNavigate = useCallback(
    () => !editorDirty || confirm("Discard unsaved editor changes?"),
    [editorDirty],
  );
  useEffect(() => registerLeaveGuard(canNavigate), [canNavigate]);
  const report = useCallback((e: unknown) => setError(errorText(e)), []);
  const [power, setPower] = useState<PowerStatus | null>(null);
  const [powerBusy, setPowerBusy] = useState(false);
  useEffect(() => {
    const api = window.workspace.power;
    if (!api || isRemoteBrowser) return;
    let live = true;
    const off = api.onStatus((status) => setPower(status));
    void api
      .status()
      .then((status) => live && setPower(status))
      .catch(() => {});
    return () => {
      live = false;
      off();
    };
  }, []);
  const togglePower = async (enabled: boolean) => {
    if (!window.workspace.power) return;
    setPowerBusy(true);
    try {
      setPower(await window.workspace.power.setEnabled(enabled));
    } catch (e) {
      report(e);
    } finally {
      setPowerBusy(false);
    }
  };
  const reload = useCallback(
    () =>
      window.workspace
        .invoke<Snapshot>("snapshot")
        .then((value) => {
          setSnapshot((current) => mergeSnapshot(current, value));
          setCore("ready");
        })
        .catch(report),
    [report],
  );
  useEffect(() => {
    void reload();
    return window.workspace.subscribe((event) => {
      if (event.type === "snapshot")
        setSnapshot((current) => mergeSnapshot(current, event.snapshot));
      if (event.type === "core.status") {
        setCore(event.status);
        if (event.message) setError(event.message);
        if (event.status === "ready") {
          setError((current) =>
            current.startsWith("Connection lost.") ? "" : current,
          );
          void reload();
        }
      }
    });
  }, [reload]);

  const projects = snapshot.projects.filter((p) => !p.hidden);
  useEffect(() => {
    if (!projects.length || projects.some((p) => p.id === projectId)) return;
    setProjectId(projects[0]!.id);
  }, [projects, projectId]);
  useEffect(() => store("project", projectId), [projectId]);
  useEffect(() => store("session", sessionId), [sessionId]);
  useEffect(() => store("files", filesOpen ? "1" : "0"), [filesOpen]);
  useEffect(
    () => store("sidebar", sidebarCollapsed ? "collapsed" : "open"),
    [sidebarCollapsed],
  );
  useEffect(() => store("board", boardMode), [boardMode]);

  const project = projects.find((p) => p.id === projectId);
  const hosts = snapshot.hosts || [];
  const hostOf = (p?: Project) =>
    p?.hostId ? hosts.find((h) => h.id === p.hostId) : undefined;
  // An SSH folder's tools are the ones its host reported, never this computer's.
  const projectHost = hostOf(project);
  const projectCapabilities = project?.hostId
    ? projectHost?.capabilities || []
    : snapshot.capabilities;
  const session = snapshot.sessions.find(
    (s) => s.id === sessionId && s.projectId === projectId,
  );
  const target = targets[projectId] || "";
  const folderSessions = useMemo(
    () =>
      orderSessions(snapshot.sessions.filter((s) => s.projectId === projectId)),
    [snapshot.sessions, projectId],
  );
  const tabs = useMemo(() => {
    const open = folderSessions.filter(isOpen);
    const ended = folderSessions.filter((s) => !isOpen(s)).slice(0, 4);
    const list = [...open, ...ended];
    if (session && !list.includes(session)) list.push(session);
    return list;
  }, [folderSessions, session]);
  const tasks = snapshot.tasks.filter((t) => t.projectId === projectId);
  const attempts = snapshot.attempts.filter((a) => a.projectId === projectId);
  const attempt = session?.attemptId
    ? snapshot.attempts.find((a) => a.id === session.attemptId)
    : undefined;
  // Files follow a task attempt's isolated worktree when one is selected.
  const reviewTree =
    reviewOverride !== null
      ? reviewOverride || undefined
      : session?.worktreePath ||
        (attempt && project && attempt.worktreePath !== project.path
          ? attempt.worktreePath
          : undefined);
  const allSessions = useMemo(
    () => orderSessions(snapshot.sessions),
    [snapshot.sessions],
  );
  const needsYou = allSessions.filter(
    (s) =>
      s.status === "running" &&
      (s.activity === "needs" || s.activity === "error"),
  );
  const openSessions = allSessions.filter(isOpen);
  // Archived (hidden) ended sessions stay on the canvas's "Hidden & archived" list.
  const endedSessions = allSessions
    .filter((s) => !isOpen(s) && !s.canvasHidden)
    .slice(0, 12);
  const projectName = (id: string) =>
    snapshot.projects.find((p) => p.id === id)?.name || "Folder";
  const titleOf = (s: Session) =>
    sessionTitle(s, snapshot.attempts, snapshot.tasks);
  const coreReason =
    core === "ready" || (core === "starting" && snapshot.projects.length)
      ? ""
      : core === "failed"
        ? "The workspace core stopped. Reopen the app."
        : "Reconnecting to the workspace…";
  // What a one-click launch will use, shown on the Launchpad cards.
  const launchProfile =
    profilesAvailable() && !project?.hostId
      ? profiles.profiles.find((p) => p.id === choices.profileId)
      : undefined;
  const launchChips: Partial<Record<Provider, string>> = {
    claude: [launchProfile?.label, choices.models.claude.trim()]
      .filter(Boolean)
      .join(" · "),
    codex: choices.models.codex.trim(),
  };
  const disabledReason =
    coreReason ||
    (project?.hostId && projectHost?.state !== "connected"
      ? `${projectHost?.label || "This SSH host"} is not connected. Connect it from SSH hosts; its sessions keep running there.`
      : "");

  // ---- Notifications: needs-you, finished turns and unexpected exits.
  const previous = useRef(
    new Map<string, Pick<Session, "status" | "activity">>(),
  );
  const endedByUser = useRef(new Set<string>());
  const [renamingId, setRenamingId] = useState("");
  const renaming = useRef("");
  renaming.current = renamingId;
  const visibleSession = useRef("");
  visibleSession.current = view === "terminals" ? session?.id || "" : "";
  const dismissToast = (id: string) =>
    setToasts((current) => current.filter((t) => t.id !== id));
  useEffect(() => {
    const before = previous.current;
    const next = new Map<string, Pick<Session, "status" | "activity">>();
    for (const s of snapshot.sessions) {
      next.set(s.id, { status: s.status, activity: s.activity });
      const was = before.get(s.id);
      if (!was) continue;
      let message = "";
      if (
        s.status === "running" &&
        s.activity === "needs" &&
        was.activity !== "needs"
      )
        message = "needs you";
      else if (s.activity === "error" && was.activity !== "error")
        message = "could not finish its turn";
      else if (s.activity === "done" && was.activity === "running")
        message = "finished its turn";
      else if (
        s.status === "exited" &&
        was.status !== "exited" &&
        !endedByUser.current.has(s.id)
      )
        message =
          s.exitCode && s.exitCode !== 0
            ? `exited with status ${s.exitCode}`
            : "ended";
      if (!message) continue;
      const title = `${providerName(s.provider)} ${message}`;
      const detail = `${projectName(s.projectId)} · ${sessionLocation(
        s,
        snapshot.projects.find((p) => p.id === s.projectId),
      )}`;
      const away = document.hidden || !document.hasFocus();
      if (
        away &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        try {
          const note = new Notification(title, { body: detail, tag: s.id });
          note.onclick = () => {
            window.focus();
            openSession(s);
          };
        } catch {}
      }
      if (away || visibleSession.current !== s.id) {
        const toast = {
          id: createId(),
          sessionId: s.id,
          title,
          detail,
          tone: sessionState(s).tone,
        };
        setToasts((current) => [toast, ...current].slice(0, 3));
        setTimeout(() => dismissToast(toast.id), 9000);
      }
    }
    previous.current = next;
    // openSession is stable enough for a notification click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.sessions]);
  useEffect(() => {
    document.title = needsYou.length
      ? `(${needsYou.length}) Agent Workspace`
      : "Agent Workspace";
  }, [needsYou.length]);

  // ---- Navigation
  function chooseProject(id: string) {
    if (id !== projectId && !canNavigate()) return;
    setDrawer(false);
    setBrowsing(false);
    setProblem(null);
    setFolderMenu(false);
    if (id === projectId) return;
    setProjectId(id);
    setTaskId("");
    setGit(null);
    const first = orderSessions(
      snapshot.sessions.filter((s) => s.projectId === id && isOpen(s)),
    )[0];
    setSessionId(first?.id || "");
    setChoices((current) => ({ ...current, worktreePath: "" }));
    setReviewOverride(null);
  }
  function openSession(s: Session, draft?: string) {
    const sessionAttempt = s.attemptId
      ? snapshot.attempts.find((a) => a.id === s.attemptId)
      : undefined;
    const sessionProject = snapshot.projects.find((p) => p.id === s.projectId);
    const tree =
      s.worktreePath ||
      (sessionAttempt &&
      sessionProject &&
      sessionAttempt.worktreePath !== sessionProject.path
        ? sessionAttempt.worktreePath
        : undefined);
    if (sessionProject?.hidden) {
      setError(
        "This session's folder was removed from the list. Open the folder again to see it.",
      );
      return;
    }
    if ((s.projectId !== projectId || tree !== reviewTree) && !canNavigate())
      return;
    if (s.projectId !== projectId) {
      setProjectId(s.projectId);
      setTaskId("");
      setGit(null);
    }
    setReviewOverride(null);
    setHandoffDraft(
      draft ? { sessionId: s.id, generation: s.generation, text: draft } : null,
    );
    setSessionId(s.id);
    setBrowsing(false);
    setView("terminals");
    setMobilePane("terminal");
    setDrawer(false);
  }
  function switchView(next: View) {
    if (next === view) return;
    if (!canNavigate()) return;
    setView(next);
    setMobilePane("terminal");
  }
  const browse = useCallback(() => {
    if (!canNavigate()) return;
    setDrawer(false);
    setFolderMenu(false);
    if (window.workspace.browseDirectory) setBrowsing(true);
  }, [canNavigate]);
  const openFolder = useCallback(
    async (path: string) => {
      try {
        const added = await window.workspace.invoke<Project>("project.add", {
          path,
        });
        setBrowsing(false);
        setProjectId(added.id);
        setTaskId("");
        setGit(null);
        setView("terminals");
        setMobilePane("terminal");
        setSessionId(
          orderSessions(
            snapshot.sessions.filter(
              (s) => s.projectId === added.id && isOpen(s),
            ),
          )[0]?.id || "",
        );
        await reload();
      } catch (e) {
        report(e);
      }
    },
    [reload, report, snapshot.sessions],
  );
  const systemPicker = useCallback(async () => {
    if (!canNavigate()) return;
    try {
      const path = await window.workspace.chooseDirectory();
      if (path) await openFolder(path);
    } catch (e) {
      report(e);
    }
  }, [canNavigate, openFolder, report]);

  // ---- Launching
  async function invokeLaunch(
    provider: Provider,
    key: string,
    payload: Record<string, unknown>,
    stay = false,
  ) {
    setLaunching(provider);
    setProblem(null);
    try {
      const result = await window.workspace.invoke<{ session: Session }>(
        "terminal.open",
        { ...payload, idempotencyKey: key },
      );
      setSessionId(result.session.id);
      if (!stay) {
        setView("terminals");
        setMobilePane("terminal");
      }
      if (provider !== "shell" && payload.prompt)
        setChoices((current) => ({ ...current, prompt: "" }));
      return result.session;
    } catch (e) {
      const message = errorText(e);
      setProblem({
        provider,
        message,
        kind: /not installed/.test(message)
          ? "missing"
          : /uncertain|outcome unknown|outcome is unknown|timed out|interrupted/i.test(
                message,
              )
            ? "uncertain"
            : "error",
        retry: { key, payload },
      });
      return undefined;
    } finally {
      setLaunching(null);
    }
  }
  async function launch(provider: Provider, stay = false) {
    if (!project) return;
    if ("Notification" in window && Notification.permission === "default")
      void Notification.requestPermission().catch(() => {});
    const cap = capability(projectCapabilities, provider);
    if (cap && !cap.available) {
      setProblem({ provider, message: cap.detail, kind: "missing" });
      return undefined;
    }
    // The Files panel follows the new session, so a different worktree would
    // drop the editor's unsaved changes.
    if (
      !stay &&
      reviewOverride === null &&
      (choices.worktreePath || undefined) !== reviewTree &&
      !canNavigate()
    )
      return undefined;
    const model = provider === "shell" ? "" : choices.models[provider].trim();
    const prompt = provider === "shell" ? "" : choices.prompt;
    return invokeLaunch(
      provider,
      createId(),
      {
        projectId: project.id,
        provider,
        ...(choices.worktreePath
          ? { worktreePath: choices.worktreePath }
          : target
            ? { path: target }
            : {}),
        ...(model ? { model } : {}),
        ...(prompt.trim() ? { prompt } : {}),
        // A profile only for a new Claude session in a folder on this computer.
        ...(provider === "claude" &&
        !project.hostId &&
        profiles.profiles.some((p) => p.id === choices.profileId)
          ? { profileId: choices.profileId }
          : {}),
      },
      stay,
    );
  }
  /** `stay` keeps the current view (the session board files the new card itself). */
  function resume(s: Session, stay = false) {
    return invokeLaunch(
      s.provider,
      createId(),
      {
        projectId: s.projectId,
        provider: s.provider,
        resumeSessionId: s.id,
      },
      stay,
    );
  }
  function restart(s: Session, stay = false) {
    const sessionProject = snapshot.projects.find((p) => p.id === s.projectId);
    const relative =
      sessionProject && s.cwd.startsWith(sessionProject.path + "/")
        ? s.cwd.slice(sessionProject.path.length + 1)
        : "";
    const tree = s.attemptId
      ? snapshot.attempts.find((a) => a.id === s.attemptId)?.worktreePath
      : undefined;
    return invokeLaunch(
      s.provider,
      createId(),
      {
        projectId: s.projectId,
        provider: s.provider,
        ...(tree && sessionProject && tree !== sessionProject.path
          ? { worktreePath: tree }
          : relative
            ? { path: relative }
            : {}),
        ...(s.model ? { model: s.model } : {}),
      },
      stay,
    );
  }
  async function addNote() {
    if (!project) return undefined;
    try {
      const note = await window.workspace.invoke<{ id: string }>(
        "note.create",
        {
          projectId: project.id,
          title: "Note",
          body: "",
        },
      );
      return note.id;
    } catch (e) {
      report(e);
      return undefined;
    }
  }
  async function hideProject(target = project) {
    if (!target) return;
    setFolderMenu(false);
    if (
      !confirm(
        `Remove ${target.name} from your folders? Files on disk are not touched, and opening the folder again brings back its history.`,
      ) ||
      (target.id === projectId && !canNavigate())
    )
      return;
    try {
      await window.workspace.invoke("project.hide", { projectId: target.id });
      if (target.id === projectId) setSessionId("");
    } catch (e) {
      report(e);
    }
  }

  // ---- Keyboard
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setModal((m) => (m === "palette" ? null : m));
        setFolderMenu(false);
        return;
      }
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      // Off macOS, Ctrl shortcuts inside a terminal belong to the terminal.
      if (!isMac && (e.target as HTMLElement | null)?.closest?.(".xterm"))
        return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setModal((m) => (m === "palette" ? null : "palette"));
      } else if (k === "o" && window.workspace.browseDirectory) {
        e.preventDefault();
        browse();
      } else if (k === "n" && projectId) {
        e.preventDefault();
        setModalTask(undefined);
        setModal("task");
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [projectId, browse]);
  // ---- Application menu (desktop): the same actions as the shortcuts.
  const menuRef = useRef<(action: MenuAction) => void>(() => {});
  menuRef.current = (action) => {
    if (action === "settings") setSettingsPanel(true);
    else if (action === "palette") setModal("palette");
    else if (action === "open-folder") browse();
    else if (action === "new-task" && projectId) {
      setModalTask(undefined);
      setModal("task");
    } else if (action === "view-terminals" && projectId)
      switchView("terminals");
    else if (action === "view-board" && projectId) switchView("board");
    else if (action === "view-canvas" && projectId) switchView("canvas");
    else if (action === "toggle-sidebar") toggleSidebar(!sidebarCollapsed);
    else if (action === "toggle-files" && projectId) {
      if (filesOpen) collapseFiles();
      else setFilesOpen(true);
    }
  };
  useEffect(
    () => window.workspace.onMenu?.((action) => menuRef.current(action)),
    [],
  );
  useEffect(() => {
    if (!editorDirty) return;
    function preventUnsavedClose(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "Unsaved editor changes";
      setError(
        "Save your editor changes or close the editor and discard them before closing this window.",
      );
    }
    window.addEventListener("beforeunload", preventUnsavedClose);
    return () =>
      window.removeEventListener("beforeunload", preventUnsavedClose);
  }, [editorDirty]);

  const boardSwitch = (
    <div className="board-mode" role="group" aria-label="Board shows">
      {(["sessions", "tasks"] as const).map((mode) => (
        <button
          key={mode}
          className={boardMode === mode ? "active" : ""}
          aria-pressed={boardMode === mode}
          onClick={() => setBoardMode(mode)}
        >
          {mode === "sessions" ? "Sessions" : "Tasks"}
        </button>
      ))}
    </div>
  );
  const showBrowser =
    !isRemoteBrowser &&
    !!window.workspace.browseDirectory &&
    (browsing || !project);
  // Enter, Escape and blur can all end one rename; only the first counts.
  async function renameSession(s: Session, title: string | null) {
    if (renaming.current !== s.id) return;
    renaming.current = "";
    setRenamingId("");
    if (title === null) return;
    title = title.trim();
    if (!title || title === titleOf(s)) return;
    try {
      await window.workspace.invoke("session.rename", {
        sessionId: s.id,
        generation: s.generation,
        title,
        titleRevision: s.titleRevision ?? 0,
      });
    } catch (e) {
      report(e);
    }
  }
  // Right-click menus use native menus on the desktop; the remote browser
  // keeps its own default menu.
  async function sessionMenu(event: React.MouseEvent, s: Session) {
    const menu = window.workspace.contextMenu;
    if (!menu) return;
    event.preventDefault();
    const sessionProject = snapshot.projects.find((p) => p.id === s.projectId);
    const running = s.status === "running";
    const choice = await menu([
      { id: "open", label: "Open" },
      { id: "rename", label: "Rename…" },
      { type: "separator" },
      ...(sessionProject
        ? [{ id: "copy-path", label: "Copy folder path" }]
        : []),
      { type: "separator" },
      running
        ? { id: "end", label: "End session…" }
        : { id: "archive", label: "Archive" },
    ]);
    if (choice === "open") openSession(s);
    else if (choice === "rename") setRenamingId(s.id);
    else if (choice === "copy-path" && sessionProject)
      void navigator.clipboard
        ?.writeText(s.worktreePath || sessionProject.path)
        .catch(() => {});
    else if (choice === "end") {
      if (
        !confirm(
          `End ${titleOf(s)}? Its process stops and its final screen is saved. The folder and files are unchanged.`,
        )
      )
        return;
      endedByUser.current.add(s.id);
      await endSession(s).catch(report);
    } else if (choice === "archive")
      await window.workspace
        .invoke("session.canvas", {
          sessionId: s.id,
          generation: s.generation,
          hidden: true,
        })
        .catch(report);
  }
  async function folderMenuAt(event: React.MouseEvent, p: Project) {
    const menu = window.workspace.contextMenu;
    if (!menu) return;
    event.preventDefault();
    const choice = await menu([
      { id: "open", label: "Open" },
      { id: "new-task", label: "New task…" },
      { id: "copy-path", label: "Copy folder path" },
      { type: "separator" },
      { id: "remove", label: "Remove from list…" },
    ]);
    if (choice === "open") chooseProject(p.id);
    else if (choice === "new-task") {
      chooseProject(p.id);
      setModalTask(undefined);
      setModal("task");
    } else if (choice === "copy-path")
      void navigator.clipboard?.writeText(p.path).catch(() => {});
    else if (choice === "remove") void hideProject(p);
  }
  const sidebarSession = (s: Session) => {
    const sessionProject = snapshot.projects.find((p) => p.id === s.projectId);
    if (renamingId === s.id)
      return (
        <form
          key={s.id}
          className="session-row renaming"
          onSubmit={(event) => {
            event.preventDefault();
            void renameSession(
              s,
              new FormData(event.currentTarget).get("title") as string,
            );
          }}
        >
          <ProviderGlyph provider={s.provider} />
          <input
            name="title"
            aria-label={`Rename ${titleOf(s)}`}
            defaultValue={titleOf(s)}
            maxLength={120}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                void renameSession(s, null);
              }
            }}
            onBlur={(event) => void renameSession(s, event.currentTarget.value)}
          />
        </form>
      );
    return (
      <button
        key={s.id}
        onContextMenu={(event) => void sessionMenu(event, s)}
        className={
          "session-row tone-" +
          sessionState(s).tone +
          (s.id === session?.id && view === "terminals" && !showBrowser
            ? " selected"
            : "")
        }
        aria-label={[
          titleOf(s),
          sessionProject?.name || "Folder",
          sessionState(s).label,
        ].join(", ")}
        onClick={() => openSession(s)}
      >
        <ProviderGlyph provider={s.provider} />
        <span className="session-row-text">
          <strong>{titleOf(s)}</strong>
          <small>
            {sessionProject?.name || "Folder"}
            {sessionLocation(s, sessionProject) === "/"
              ? ""
              : " / " + sessionLocation(s, sessionProject)}
            {s.profileId ? " · " + profileLabel(s.profileId, profiles) : ""}
          </small>
        </span>
        <StatusBadge session={s} compact />
      </button>
    );
  };
  return (
    <div
      className={
        "app-shell " +
        (sidebarCollapsed ? "sidebar-collapsed " : "") +
        (drawer ? "drawer-open " : "") +
        (mobilePane === "files" && view === "terminals"
          ? "mobile-files"
          : "mobile-terminal")
      }
    >
      {drawer ? (
        <button
          className="drawer-scrim"
          aria-label="Close folders and sessions"
          onClick={() => setDrawer(false)}
        />
      ) : null}
      <aside
        ref={drawerPanel}
        className="sidebar"
        aria-label="Folders and sessions"
      >
        <div className="sidebar-head">
          <BrandMark />
          <div className="brand-name">
            Agent Workspace
            <small>
              {isRemoteBrowser ? "Remote workspace" : "This computer"}
            </small>
          </div>
          <button
            ref={sidebarCollapse}
            className="icon-button desktop-only"
            aria-label="Collapse folders and sessions"
            title="Collapse sidebar"
            onClick={() => toggleSidebar(true)}
          >
            <PanelLeftClose size={17} />
          </button>
          <button
            className="drawer-close icon-button"
            aria-label="Close folders and sessions"
            onClick={() => setDrawer(false)}
          >
            <X size={18} />
          </button>
        </div>
        <button
          className="command-button"
          aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
          onClick={() => setModal("palette")}
        >
          <Search size={14} />
          <span>Search and commands</span>
          <kbd aria-hidden="true">{modKey} K</kbd>
        </button>
        <section className="side-section" aria-labelledby="folders-heading">
          <header>
            <h2 id="folders-heading">Folders</h2>
            {window.workspace.browseDirectory ? (
              <button
                className="icon-button"
                aria-label="Open folder"
                title={`Open a folder (${modKey} O)`}
                onClick={browse}
              >
                <FolderPlus size={15} />
              </button>
            ) : null}
          </header>
          <nav className="folder-list" aria-label="Folders">
            {projects.map((p) => {
              const open = snapshot.sessions.filter(
                (s) => s.projectId === p.id && isOpen(s),
              );
              const waiting = open.some((s) => s.activity === "needs");
              return (
                <button
                  key={p.id}
                  className={
                    "folder-row" +
                    (p.id === projectId && !showBrowser ? " selected" : "")
                  }
                  title={
                    p.hostId ? `${hostOf(p)?.label || "SSH"}:${p.path}` : p.path
                  }
                  aria-label={[
                    p.name,
                    ...(p.hostId ? [`on ${hostOf(p)?.label || "SSH"}`] : []),
                    ...(waiting ? ["needs you"] : []),
                    ...(open.length
                      ? [
                          `${open.length} open ${open.length === 1 ? "session" : "sessions"}`,
                        ]
                      : []),
                  ].join(", ")}
                  onClick={() => chooseProject(p.id)}
                  onContextMenu={(event) => void folderMenuAt(event, p)}
                >
                  {p.hostId ? <Server size={15} /> : <FolderOpen size={15} />}
                  <span>{p.name}</span>
                  {p.hostId ? (
                    <span
                      className="host-badge"
                      title={`On SSH host ${hostOf(p)?.label || "removed host"}: ${hostStateLabel(hostOf(p)?.state || "disconnected")}`}
                    >
                      <span
                        className={
                          "ssh-dot " + (hostOf(p)?.state || "disconnected")
                        }
                        aria-hidden="true"
                      />
                      {hostOf(p)?.label || "SSH"}
                    </span>
                  ) : null}
                  {waiting ? (
                    <span
                      className="needs-dot"
                      title="A session needs you"
                    ></span>
                  ) : null}
                  {open.length ? (
                    <span className="count-pill">{open.length}</span>
                  ) : null}
                </button>
              );
            })}
            {!projects.length ? (
              isRemoteBrowser ? (
                <p className="sidebar-empty">
                  No folders are shared yet. The host owner registers folders on
                  the host computer.
                </p>
              ) : (
                <button className="folder-row add" onClick={browse}>
                  <FolderPlus size={15} />
                  <span>Open a folder</span>
                </button>
              )
            ) : null}
          </nav>
        </section>
        <section
          className="side-section sessions-section"
          aria-labelledby="sessions-heading"
        >
          <header>
            <h2 id="sessions-heading">Sessions</h2>
            {openSessions.length ? (
              <span className="count-pill">{openSessions.length} open</span>
            ) : null}
          </header>
          <div className="session-list">
            {needsYou.length ? (
              <>
                <p className="group-label needs">
                  <Bell size={11} /> Needs you
                </p>
                {needsYou.map(sidebarSession)}
              </>
            ) : null}
            {openSessions.filter((s) => !needsYou.includes(s)).length ? (
              <>
                {needsYou.length ? <p className="group-label">Open</p> : null}
                {openSessions
                  .filter((s) => !needsYou.includes(s))
                  .map(sidebarSession)}
              </>
            ) : null}
            {!openSessions.length ? (
              <p className="sidebar-empty">
                Nothing running. Choose a folder, then Claude, Codex or Shell.
              </p>
            ) : null}
            {endedSessions.length ? (
              <>
                <button
                  className="group-toggle"
                  aria-expanded={showEnded}
                  onClick={() => setShowEnded((v) => !v)}
                >
                  <ChevronDown
                    size={12}
                    className={showEnded ? "" : "rotated"}
                  />
                  Ended · {endedSessions.length}
                </button>
                {showEnded ? endedSessions.map(sidebarSession) : null}
              </>
            ) : null}
          </div>
        </section>
        <footer className="sidebar-foot">
          <div className="connection" role="status">
            <span
              className={
                "tiny-dot " +
                (core === "failed" ? "red" : disabledReason ? "neutral" : "")
              }
            />
            {isRemoteBrowser ? "Host" : "Local core"}
            <span>
              {disabledReason
                ? core === "failed"
                  ? "Stopped"
                  : "Reconnecting"
                : "Connected"}
            </span>
          </div>
          {hosts.map((h) => (
            <div
              key={h.id}
              className="host-connection"
              role="status"
              aria-label={`SSH host ${h.label}`}
            >
              <span className={"ssh-dot " + h.state} aria-hidden="true" />
              {h.label}
              <span>{hostStateLabel(h.state)}</span>
            </div>
          ))}
          {snapshot.capabilities.some((c) => !c.available) ? (
            <p className="capabilities" aria-label="Missing tools">
              Not installed:{" "}
              {snapshot.capabilities
                .filter((c) => !c.available)
                .map((c) => (
                  <span key={c.name} title={c.detail}>
                    {c.name}
                  </span>
                ))}
            </p>
          ) : null}
          <button
            className="icon-button foot-button"
            onClick={() => setSettingsPanel(true)}
            aria-label="Settings and connections"
            title="Settings and connections"
          >
            <SettingsIcon size={16} />
          </button>
        </footer>
      </aside>
      <main className="main">
        <header className="topbar">
          {sidebarCollapsed ? (
            <button
              ref={sidebarRestore}
              className="icon-button desktop-only"
              aria-label="Show folders and sessions"
              title="Show sidebar"
              onClick={() => toggleSidebar(false)}
            >
              <PanelLeft size={19} />
            </button>
          ) : null}
          <button
            className="mobile-menu icon-button"
            aria-label="Open folders and sessions"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <Menu size={19} />
            {needsYou.length ? <span className="needs-dot" /> : null}
          </button>
          <div className="topbar-title">
            {showBrowser ? (
              <h1>Open a folder</h1>
            ) : project ? (
              <>
                <h1 title={project.path}>{project.name}</h1>
                {projectHost ? (
                  <span
                    className="host-badge"
                    title={`Runs on ${projectHost.label} (${projectHost.alias})`}
                  >
                    <span
                      className={"ssh-dot " + projectHost.state}
                      aria-hidden="true"
                    />
                    {projectHost.label}
                  </span>
                ) : null}
              </>
            ) : (
              <h1>Welcome</h1>
            )}
          </div>
          {/* Launch controls share the toolbar row. With a session open the
              terminal's own bar takes over; "+" brings the Launchpad back. */}
          {project && !showBrowser && !(view === "terminals" && session) ? (
            <LaunchBar
              launchers={view !== "terminals"}
              project={project}
              target={target}
              onTarget={(path) =>
                setTargets((current) => ({ ...current, [project.id]: path }))
              }
              capabilities={projectCapabilities}
              choices={choices}
              onChoices={(next) => {
                setChoices(next);
                try {
                  localStorage.setItem(
                    "workspace.launch.models",
                    JSON.stringify(next.models),
                  );
                } catch {}
              }}
              onLaunch={(provider) => void launch(provider, view === "canvas")}
              launching={launching}
              disabledReason={disabledReason}
              git={git}
              onManageProfiles={() => setProfilesPanel(true)}
            />
          ) : (
            <div className="topbar-spacer" />
          )}
          {project && !showBrowser ? (
            <nav className="view-switch" aria-label="Views">
              <button
                className={view === "terminals" ? "active" : ""}
                aria-pressed={view === "terminals"}
                onClick={() => switchView("terminals")}
              >
                <SquareTerminal size={14} />
                Terminals
              </button>
              <button
                className={view === "board" ? "active" : ""}
                aria-pressed={view === "board"}
                onClick={() => switchView("board")}
              >
                <LayoutGrid size={14} />
                Board
              </button>
              <button
                className={view === "canvas" ? "active" : ""}
                aria-pressed={view === "canvas"}
                onClick={() => switchView("canvas")}
              >
                <Network size={14} />
                Canvas
              </button>
            </nav>
          ) : null}
          <div className="topbar-actions">
            {showBrowser && project ? (
              <button
                className="button ghost small"
                onClick={() => setBrowsing(false)}
              >
                Back to {project.name}
              </button>
            ) : null}
            {project && !showBrowser && view === "terminals" ? (
              <button
                ref={filesToggle}
                className="icon-button desktop-only"
                aria-label="Toggle files panel"
                aria-pressed={filesOpen}
                title={filesOpen ? "Collapse files panel" : "Show files panel"}
                onClick={() =>
                  filesOpen ? collapseFiles() : setFilesOpen(true)
                }
              >
                {filesOpen ? (
                  <PanelRightClose size={17} />
                ) : (
                  <PanelRight size={17} />
                )}
              </button>
            ) : null}
            <button
              className="icon-button desktop-only"
              aria-label="Appearance settings"
              title="Appearance: Light, Dark or System"
              onClick={() => setSettingsPanel(true)}
            >
              <SunMoon size={17} />
            </button>
            {project && !showBrowser ? (
              <div className="menu-anchor">
                <button
                  className="icon-button"
                  aria-label="Folder actions"
                  aria-expanded={folderMenu}
                  onClick={() => setFolderMenu((open) => !open)}
                >
                  <Ellipsis size={17} />
                </button>
                {folderMenu ? (
                  <div className="popover menu" role="menu">
                    <button
                      role="menuitem"
                      onClick={() => {
                        setFolderMenu(false);
                        void navigator.clipboard
                          ?.writeText(project.path)
                          .catch(() => {});
                      }}
                    >
                      Copy folder path
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setFolderMenu(false);
                        setModalTask(undefined);
                        setModal("task");
                      }}
                    >
                      New task
                    </button>
                    {window.workspace.browseDirectory ? (
                      <button
                        role="menuitem"
                        onClick={() => void hideProject(project)}
                      >
                        Remove from list…
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </header>
        {error ? (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        ) : null}
        {showBrowser ? (
          <div className="browser-with-setup">
            {!snapshot.projects.length ||
            snapshot.capabilities.some(
              (c) => c.name === "tmux" && !c.available,
            ) ? (
              <FirstRunChecklist
                capabilities={snapshot.capabilities}
                onCheckAgain={reload}
              />
            ) : null}
            <FolderBrowser
              projects={snapshot.projects}
              sessions={snapshot.sessions}
              onOpenFolder={openFolder}
              onSelectProject={chooseProject}
              onSystemPicker={() => void systemPicker()}
            />
          </div>
        ) : !project ? (
          <div className="empty-state">
            <BrandMark size={44} />
            <h2>No folders are shared with this browser yet</h2>
            <p>
              Folders live on the host computer. On the host, open the folder in
              the desktop app, then stop and enable Remote access again, or
              start the server with <code>--project /path/to/folder</code>.
            </p>
          </div>
        ) : (
          <div className="workspace">
            {problem ? (
              <LaunchNotice
                hostLabel={projectHost?.label}
                problem={problem}
                target={target}
                onDismiss={() => setProblem(null)}
                onRetry={() =>
                  problem.retry
                    ? void invokeLaunch(
                        problem.provider,
                        problem.kind === "uncertain"
                          ? problem.retry.key
                          : createId(),
                        problem.retry.payload,
                      )
                    : void launch(problem.provider)
                }
                onCheckAgain={async () => {
                  await reload();
                  setProblem(null);
                  const fresh = await window.workspace
                    .invoke<Snapshot>("snapshot")
                    .catch(() => null);
                  const freshHost = fresh?.hosts?.find(
                    (h) => h.id === project.hostId,
                  );
                  const cap = (
                    project.hostId
                      ? freshHost?.capabilities
                      : fresh?.capabilities
                  )?.find((c) => c.name === problem.provider);
                  if (cap && !cap.available)
                    setProblem({ ...problem, message: cap.detail });
                }}
                onShell={() => void launch("shell")}
                onRoot={() =>
                  setTargets((current) => ({ ...current, [project.id]: "" }))
                }
              />
            ) : null}
            <div
              className={
                "workspace-body" +
                (view === "terminals" && filesOpen ? " with-files" : "")
              }
            >
              <div
                className="stage"
                inert={!!launching}
                aria-busy={!!launching}
              >
                <ErrorBoundary area="This view" resetKey={view + projectId}>
                  {view === "terminals" ? (
                    <>
                      {tabs.length ? (
                        <div
                          className="session-tabs"
                          aria-label="Sessions in this folder"
                        >
                          {tabs.map((s) => (
                            <button
                              key={s.id}
                              className={
                                "session-tab tone-" +
                                sessionState(s).tone +
                                (s.id === session?.id ? " active" : "")
                              }
                              aria-pressed={s.id === session?.id}
                              aria-label={[
                                titleOf(s),
                                ...(sessionLocation(s, project) !== "/"
                                  ? [sessionLocation(s, project)]
                                  : []),
                                sessionState(s).label,
                              ].join(", ")}
                              title={`${providerName(s.provider)} · ${s.cwd}`}
                              onClick={() => openSession(s)}
                            >
                              <ProviderGlyph provider={s.provider} size={13} />
                              <span>
                                {titleOf(s)}
                                {sessionLocation(s, project) !== "/" ? (
                                  <em>{sessionLocation(s, project)}</em>
                                ) : null}
                              </span>
                              <StatusBadge session={s} compact />
                            </button>
                          ))}
                          <button
                            className={
                              "session-tab new-tab" +
                              (!session ? " active" : "")
                            }
                            aria-label="New session"
                            title="Start another session"
                            onClick={() => {
                              // The Files panel follows a worktree session; leaving
                              // it would drop the editor's unsaved changes.
                              if (
                                reviewOverride === null &&
                                reviewTree &&
                                !canNavigate()
                              )
                                return;
                              setSessionId("");
                            }}
                          >
                            <Plus size={14} />
                          </button>
                          {session && git ? (
                            <span
                              className={
                                "git-chip tabs-git" +
                                (git.available ? "" : " muted-chip")
                              }
                              title={git.message || ""}
                            >
                              <GitBranch size={12} aria-hidden="true" />
                              {git.available
                                ? `${git.branch || "detached"}${git.changes ? ` · ${git.changes} changed` : ""}`
                                : "No Git"}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      {session ? (
                        <SessionView
                          key={session.id}
                          session={session}
                          project={project}
                          title={titleOf(session)}
                          onResume={(s) => void resume(s)}
                          onRestart={(s) => void restart(s)}
                          onEnded={(s) => endedByUser.current.add(s.id)}
                          report={report}
                          sessions={snapshot.sessions}
                          titleOf={titleOf}
                          onOpen={openSession}
                          handoffDraft={
                            handoffDraft?.sessionId === session.id &&
                            handoffDraft.generation === session.generation
                              ? handoffDraft.text
                              : undefined
                          }
                          clearHandoff={() => setHandoffDraft(null)}
                        />
                      ) : (
                        <Launchpad
                          project={project}
                          host={projectHost}
                          onOpenHosts={() => setSSHPanel(true)}
                          target={target}
                          worktree={choices.worktreePath}
                          chips={launchChips}
                          capabilities={projectCapabilities}
                          launching={launching}
                          disabledReason={disabledReason}
                          onLaunch={(provider) => void launch(provider)}
                          recent={folderSessions
                            .filter((s) => !isOpen(s))
                            .slice(0, 4)}
                          titleOf={titleOf}
                          onOpen={openSession}
                          onResume={(s) => void resume(s)}
                        />
                      )}
                    </>
                  ) : null}
                  {view === "board" && boardMode === "sessions" ? (
                    <SessionBoard
                      key={projectId}
                      project={project}
                      sessions={folderSessions}
                      boards={snapshot.boardLanes || []}
                      capabilities={projectCapabilities}
                      disabledReason={disabledReason}
                      launching={launching}
                      titleOf={titleOf}
                      onLaunch={(provider) => launch(provider, true)}
                      onResume={(s) => resume(s, true)}
                      onRestart={(s) => restart(s, true)}
                      onEnded={(s) => endedByUser.current.add(s.id)}
                      report={report}
                      modeSwitch={boardSwitch}
                    />
                  ) : null}
                  {view === "board" && boardMode === "tasks" ? (
                    <Board
                      modeSwitch={boardSwitch}
                      projectId={project?.hostId ? undefined : project?.id}
                      tasks={tasks}
                      attempts={attempts}
                      sessions={snapshot.sessions}
                      selectedTaskId={taskId}
                      onSelectTask={setTaskId}
                      onNewTask={() => {
                        setModalTask(undefined);
                        setModal("task");
                      }}
                      onEditTask={(t) => {
                        setModalTask(t);
                        setModal("edit-task");
                      }}
                      onStartAttempt={(t) => {
                        setModalTask(t);
                        setModal("attempt");
                      }}
                      onOpenSession={(id) => {
                        const s = snapshot.sessions.find((x) => x.id === id);
                        if (s) openSession(s);
                      }}
                      report={report}
                    />
                  ) : null}
                  {view === "canvas" ? (
                    <div className="canvas-area">
                      <CanvasView
                        key={projectId}
                        onAddNote={() => void addNote()}
                        projectId={projectId}
                        titleOf={titleOf}
                        onOpenSession={openSession}
                        connectRequested={connectRequested}
                        onConnectHandled={() => setConnectRequested(false)}
                        attempts={attempts}
                        sessions={snapshot.sessions.filter(
                          (s) => s.projectId === projectId,
                        )}
                        notes={snapshot.notes.filter(
                          (n) => n.projectId === projectId,
                        )}
                        layout={snapshot.layouts.find(
                          (l) => l.projectId === projectId,
                        )}
                        report={report}
                        onCreate={async (kind) => {
                          if (kind === "note") return addNote();
                          const created = await launch(kind, true);
                          return created
                            ? created.attemptId || created.id
                            : undefined;
                        }}
                      />
                    </div>
                  ) : null}
                </ErrorBoundary>
              </div>
              {view === "terminals" ? (
                <ErrorBoundary
                  area="Files"
                  resetKey={projectId + (reviewTree || "")}
                >
                  <ReviewPanel
                    key={projectId + (reviewTree || "")}
                    collapsed={!filesOpen}
                    onCollapse={collapseFiles}
                    project={project}
                    worktreePath={reviewTree}
                    report={report}
                    onDirtyChange={setEditorDirty}
                    refreshRevision={reviewRefresh}
                    directory={reviewTree ? undefined : target}
                    onDirectoryChange={
                      reviewTree
                        ? undefined
                        : (path) =>
                            setTargets((current) => ({
                              ...current,
                              [project.id]: path,
                            }))
                    }
                    onOpenWorktree={(tree, provider) => {
                      if (!canNavigate()) return;
                      const location =
                        tree.path === project.path ? "" : tree.path;
                      setReviewOverride(location);
                      setChoices((c) => ({ ...c, worktreePath: location }));
                      if (provider)
                        void invokeLaunch(provider, createId(), {
                          projectId: project.id,
                          provider,
                          ...(location ? { worktreePath: location } : {}),
                          ...(provider === "claude" &&
                          !project.hostId &&
                          choices.profileId
                            ? { profileId: choices.profileId }
                            : {}),
                        });
                    }}
                    onSummary={setGit}
                  />
                </ErrorBoundary>
              ) : null}
            </div>
          </div>
        )}
      </main>
      <nav className="mobile-navigation" aria-label="Workspace navigation">
        <button onClick={() => setDrawer(true)}>
          <FolderOpen size={18} />
          <span>Folders</span>
          {needsYou.length ? <span className="needs-dot" /> : null}
        </button>
        <button
          className={
            view === "terminals" && mobilePane === "terminal" ? "active" : ""
          }
          onClick={() => {
            if (view === "terminals" || canNavigate()) {
              setView("terminals");
              setMobilePane("terminal");
            }
          }}
        >
          <SquareTerminal size={18} />
          <span>Terminal</span>
        </button>
        <button
          ref={mobileFiles}
          className={
            view === "terminals" && mobilePane === "files" ? "active" : ""
          }
          onClick={() => {
            if (view === "terminals" || canNavigate()) {
              setView("terminals");
              setMobilePane("files");
              setReviewRefresh((value) => value + 1);
            }
          }}
        >
          <Files size={18} />
          <span>Files</span>
        </button>
        <button
          className={view === "board" ? "active" : ""}
          onClick={() => switchView("board")}
        >
          <LayoutGrid size={18} />
          <span>Board</span>
        </button>
        <button
          className={view === "canvas" ? "active" : ""}
          onClick={() => switchView("canvas")}
        >
          <Network size={18} />
          <span>Canvas</span>
        </button>
      </nav>
      {toasts.length ? (
        <div className="toasts" aria-live="polite">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={"toast tone-" + toast.tone}
              role="status"
            >
              <span className="status-light" />
              <div>
                <strong>{toast.title}</strong>
                <small>{toast.detail}</small>
              </div>
              <button
                className="button small"
                onClick={() => {
                  dismissToast(toast.id);
                  const s = snapshot.sessions.find(
                    (x) => x.id === toast.sessionId,
                  );
                  if (s) openSession(s);
                }}
              >
                Open
              </button>
              <button
                className="icon-button"
                aria-label="Dismiss notification"
                onClick={() => dismissToast(toast.id)}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {dataPanel && !isRemoteBrowser ? (
        <WorkspaceDataPanel
          snapshot={snapshot}
          onClose={() => setDataPanel(false)}
        />
      ) : null}
      {settingsPanel ? (
        <div className="modal-backdrop">
          <section
            className="modal settings-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Settings and connections"
          >
            <header>
              <h2>Settings & connections</h2>
              <button
                aria-label="Close settings"
                onClick={() => setSettingsPanel(false)}
              >
                ×
              </button>
            </header>
            <p>
              Set up accounts and optional tools. Your folders and running
              sessions stay where they are.
            </p>
            <AppearanceSettings />
            <SettingsRows
              hosts={hosts}
              open={settingsPanel}
              close={() => setSettingsPanel(false)}
              power={power}
              powerBusy={powerBusy}
              togglePower={(on) => void togglePower(on)}
              openData={() => setDataPanel(true)}
              openProfiles={() => setProfilesPanel(true)}
              openSSH={() => setSSHPanel(true)}
              openTeam={() => setTeamPanel(true)}
              openRemote={() => setRemotePanel(true)}
            />
          </section>
        </div>
      ) : null}
      {dictationAvailable() && !isRemoteBrowser ? (
        <>
          <DictationSettings />
          <DictationNotices />
        </>
      ) : null}
      {assistAvailable() && !isRemoteBrowser ? <AssistSettings /> : null}
      {profilesPanel ? (
        <ProfilesPanel
          project={project}
          onClose={() => setProfilesPanel(false)}
          onOpened={(s) => openSession(s)}
        />
      ) : null}
      {remotePanel ? (
        <RemoteAccessPanel onClose={() => setRemotePanel(false)} />
      ) : null}
      {teamPanel && window.workspace.team ? (
        <TeamPanel
          projectId={project && !project.hostId ? project.id : ""}
          projectName={project && !project.hostId ? project.name : ""}
          onClose={() => setTeamPanel(false)}
        />
      ) : null}
      {sshPanel && window.workspace.ssh ? (
        <SSHProjectsPanel
          hosts={hosts}
          onClose={() => setSSHPanel(false)}
          onOpenProject={(added) => {
            setSSHPanel(false);
            void reload();
            if (!canNavigate()) return;
            setBrowsing(false);
            setProjectId(added.id);
            setTaskId("");
            setGit(null);
            setView("terminals");
            setMobilePane("terminal");
            setSessionId("");
          }}
        />
      ) : null}
      {(modal === "task" || modal === "edit-task") && project ? (
        <TaskModal
          existing={modal === "edit-task" ? modalTask : undefined}
          projectId={project.id}
          close={() => setModal(null)}
          created={(id) => {
            setTaskId(id);
            setModal(null);
            // The task is saved either way; only the view switch waits on the editor.
            if (!canNavigate()) return;
            setView("board");
            setBoardMode("tasks");
          }}
          report={report}
        />
      ) : null}
      {modal === "attempt" && modalTask ? (
        <AttemptModal
          task={modalTask}
          capabilities={projectCapabilities}
          close={() => setModal(null)}
          created={(result) => {
            setModal(null);
            openSession(result.session);
          }}
          report={report}
        />
      ) : null}
      {modal === "palette" ? (
        <Palette
          close={() => setModal(null)}
          items={[
            {
              id: "appearance",
              label: "Appearance · Light / white mode, Dark or System",
              keywords: "theme colour color",
              run: () => setSettingsPanel(true),
            },
            {
              id: "sidebar",
              label: sidebarCollapsed
                ? "Show folders and sessions"
                : "Collapse folders and sessions",
              run: () => toggleSidebar(!sidebarCollapsed),
            },
            {
              id: "settings",
              label: "Settings and connections",
              keywords: "preferences options keep awake",
              run: () => setSettingsPanel(true),
            },
            ...(project && profilesAvailable() && !project.hostId
              ? [
                  {
                    id: "connect",
                    label: "Connect agents · share context on Canvas",
                    keywords: "transcript handoff link",
                    run: () => {
                      switchView("canvas");
                      setConnectRequested(true);
                    },
                  },
                ]
              : []),
            ...(dictationAvailable()
              ? [
                  {
                    id: "voice",
                    label: "Voice dictation settings · microphone",
                    keywords: "speech typing mic",
                    run: () => openDictationSettings(),
                  },
                ]
              : []),
            ...(assistAvailable()
              ? [
                  {
                    id: "assist",
                    label: "AI suggestions settings",
                    keywords: "assist model name",
                    run: () => openAssistSettings(),
                  },
                ]
              : []),
            ...(profilesAvailable()
              ? [
                  {
                    id: "accounts",
                    label: "Claude accounts and profiles",
                    keywords: "account login sign in",
                    run: () => setProfilesPanel(true),
                  },
                ]
              : []),
            ...(window.workspace.remote
              ? [
                  {
                    id: "phone",
                    label: "Connect phone · remote access",
                    keywords: "pair pairing qr mobile browser",
                    run: () => setRemotePanel(true),
                  },
                ]
              : []),
            ...(window.workspace.ssh
              ? [
                  {
                    id: "ssh",
                    label: "Connect SSH computer",
                    keywords: "ssh hosts remote machine server",
                    run: () => setSSHPanel(true),
                  },
                ]
              : []),
            ...(window.workspace.team
              ? [
                  {
                    id: "team",
                    label: "Join or set up a team",
                    keywords: "team share collaborate",
                    run: () => setTeamPanel(true),
                  },
                ]
              : []),
            ...(window.workspace.browseDirectory
              ? [
                  {
                    id: "open",
                    label: "Open folder…",
                    hint: `${modKey} O`,
                    run: browse,
                  },
                ]
              : []),
            ...(project
              ? providers.map((p) => ({
                  id: "launch-" + p,
                  label: `New ${providerName(p)} in ${[project.name, target].filter(Boolean).join("/")}`,
                  run: () => void launch(p),
                }))
              : []),
            ...(project
              ? [
                  {
                    id: "view-terminals",
                    label: "Show terminals",
                    run: () => switchView("terminals"),
                  },
                  {
                    id: "view-board",
                    label: "Show board",
                    run: () => switchView("board"),
                  },
                  {
                    id: "view-canvas",
                    label: "Show canvas",
                    run: () => switchView("canvas"),
                  },
                  {
                    id: "task",
                    label: "Create task",
                    hint: `${modKey} N`,
                    run: () => {
                      setModalTask(undefined);
                      setModal("task");
                    },
                  },
                  {
                    id: "note",
                    label: "Add canvas note",
                    run: () => {
                      switchView("canvas");
                      void addNote();
                    },
                  },
                ]
              : []),
            ...projects.map((p) => ({
              id: "folder-" + p.id,
              label: p.name,
              hint: "Folder",
              run: () => chooseProject(p.id),
            })),
            ...allSessions.slice(0, 30).map((s) => ({
              id: "session-" + s.id,
              label: `${titleOf(s)} · ${projectName(s.projectId)}/${sessionLocation(
                s,
                snapshot.projects.find((p) => p.id === s.projectId),
              )}`,
              hint: sessionState(s).label,
              run: () => openSession(s),
            })),
            ...tasks.map((t) => ({
              id: "task-" + t.id,
              label: t.title,
              hint: statusLabel(t.status) || "Task",
              run: () => {
                setTaskId(t.id);
                setBoardMode("tasks");
                switchView("board");
              },
            })),
          ]}
        />
      ) : null}
    </div>
  );
}

function Launchpad({
  project,
  host,
  onOpenHosts,
  target,
  worktree,
  chips,
  capabilities,
  launching,
  disabledReason,
  onLaunch,
  recent,
  titleOf,
  onOpen,
  onResume,
}: {
  project: Project;
  /** The SSH host of an SSH folder; undefined for local folders. */
  host?: ExecutionHostView;
  onOpenHosts: () => void;
  target: string;
  /** A worktree chosen in Launch options; new sessions open there. */
  worktree: string;
  /** Profile and model each provider will launch with, when set. */
  chips: Partial<Record<Provider, string>>;
  capabilities: Snapshot["capabilities"];
  launching: Provider | null;
  disabledReason: string;
  onLaunch: (provider: Provider) => void;
  recent: Session[];
  titleOf: (s: Session) => string;
  onOpen: (s: Session) => void;
  onResume: (s: Session) => void;
}) {
  const where = worktree
    ? `worktree ${worktree.split("/").pop()}`
    : [project.name, target].filter(Boolean).join("/");
  // An SSH folder whose host is not connected cannot launch anything, so it
  // gets a Reconnect notice in place of greyed "ready" cards.
  const offline = !!project.hostId && host?.state !== "connected";
  return (
    <div className="launchpad">
      {offline ? (
        <HostOfflineNotice host={host} onOpenHosts={onOpenHosts} />
      ) : (
        <div className="launchpad-card">
          <p className="eyebrow">Ready in {where}</p>
          <h2>Open an agent or a shell here</h2>
          <div className="launchpad-options">
            {providers.map((provider) => {
              const cap = capability(capabilities, provider);
              const missing = !!cap && !cap.available;
              return (
                <button
                  key={provider}
                  className={
                    "launchpad-option launch-" +
                    provider +
                    (missing ? " is-missing" : "")
                  }
                  aria-label={`Open ${providerName(provider)} here`}
                  aria-describedby={`launchpad-${provider}-hint`}
                  title={disabledReason || undefined}
                  disabled={!!disabledReason || !!launching}
                  onClick={() => onLaunch(provider)}
                >
                  {launching === provider ? (
                    <RefreshCw size={22} className="spin" />
                  ) : (
                    <ProviderGlyph provider={provider} size={22} />
                  )}
                  <strong>{providerName(provider)}</strong>
                  {chips[provider] && !missing ? (
                    <small className="launchpad-chip">{chips[provider]}</small>
                  ) : null}
                  <span id={`launchpad-${provider}-hint`}>
                    {missing
                      ? "Not found on this host"
                      : provider === "claude"
                        ? "Claude Code, ready for your first message"
                        : provider === "codex"
                          ? "Codex CLI, ready for your first message"
                          : "A terminal in this folder"}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="hint">
            Nothing is sent until you type. Sessions keep running when you
            switch folders or views, and after you close the window.
          </p>
        </div>
      )}
      {recent.length ? (
        <div className="recent-sessions">
          <h3 className="section-label">Recently ended here</h3>
          {recent.map((s) => (
            <div key={s.id} className="recent-session">
              <ProviderGlyph provider={s.provider} />
              <button className="link-button" onClick={() => onOpen(s)}>
                {titleOf(s)}
                <small>
                  {sessionLocation(s, project)} · {sessionState(s).label}
                </small>
              </button>
              {s.provider === "claude" && s.conversationId ? (
                <button
                  className="button ghost small"
                  onClick={() => onResume(s)}
                >
                  Resume
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HostOfflineNotice({
  host,
  onOpenHosts,
}: {
  host?: ExecutionHostView;
  onOpenHosts: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ssh = window.workspace.ssh;
  const label = host?.label || "This SSH host";
  const pending =
    busy || host?.state === "connecting" || host?.state === "reconnecting";
  return (
    <div className="launchpad-card host-offline" role="status">
      <Server size={28} aria-hidden="true" />
      <p className="eyebrow">SSH folder</p>
      <h2>
        {!host
          ? "This folder's SSH host was removed"
          : pending
            ? `Connecting to ${label}…`
            : `${label} is not connected`}
      </h2>
      <p className="muted">
        {host
          ? "Sessions on this host keep running there. Connect to start new ones or reopen them."
          : "Add the host again in SSH hosts to use this folder."}
      </p>
      {host?.problem && !pending ? (
        <p className="notice notice-error">{host.problem.message}</p>
      ) : null}
      {error ? <p className="notice notice-error">{error}</p> : null}
      <div className="host-offline-actions">
        {host && ssh ? (
          <button
            className="button primary"
            disabled={pending}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await ssh.connect(host.id);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {pending ? <RefreshCw size={14} className="spin" /> : null}
            {pending ? "Connecting…" : "Reconnect"}
          </button>
        ) : null}
        {ssh ? (
          <button className="button" onClick={onOpenHosts}>
            SSH hosts…
          </button>
        ) : (
          <p className="muted">Connect it from the desktop app.</p>
        )}
      </div>
    </div>
  );
}

function LaunchNotice({
  hostLabel,
  problem,
  target,
  onDismiss,
  onRetry,
  onCheckAgain,
  onShell,
  onRoot,
}: {
  hostLabel?: string;
  problem: LaunchProblem;
  target: string;
  onDismiss: () => void;
  onRetry: () => void;
  onCheckAgain: () => void;
  onShell: () => void;
  onRoot: () => void;
}) {
  const name = providerName(problem.provider);
  return (
    <div className="notice notice-error launch-notice" role="alert">
      <div>
        <strong>
          {problem.kind === "missing"
            ? `${name} isn't available on ${hostLabel || "this host"}`
            : problem.kind === "uncertain"
              ? `${name} may or may not have started`
              : `${name} couldn't open`}
        </strong>
        <p>{problem.message}</p>
        {problem.kind === "missing" && installHints[problem.provider] ? (
          <p className="hint">
            To install it{hostLabel ? ` on ${hostLabel}` : ""}, run{" "}
            <code>{installHints[problem.provider]}</code> in a Shell{" "}
            {hostLabel ? `on ${hostLabel} ` : ""}(the shell opens there), then
            run <code>{problem.provider}</code> once to sign in. If it's already
            installed, make sure your login shell's PATH includes it.
          </p>
        ) : null}
        {problem.kind === "uncertain" ? (
          <p className="hint">
            Checking again asks about the same launch. It never starts a second
            process.
          </p>
        ) : null}
      </div>
      <div className="notice-actions">
        {problem.kind === "missing" ? (
          <>
            <button className="button small" onClick={onCheckAgain}>
              <RefreshCw size={13} />
              Check again
            </button>
            <button className="button ghost small" onClick={onShell}>
              Open a Shell here
            </button>
          </>
        ) : (
          <button className="button small" onClick={onRetry}>
            <RefreshCw size={13} />
            {problem.kind === "uncertain"
              ? "Check the same launch"
              : "Try again"}
          </button>
        )}
        {target && /no longer exists|permission/i.test(problem.message) ? (
          <button className="button ghost small" onClick={onRoot}>
            Use the folder root
          </button>
        ) : null}
        <button
          className="icon-button"
          aria-label="Dismiss launch problem"
          onClick={onDismiss}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function SettingsRows({
  hosts,
  open,
  close,
  power,
  powerBusy,
  togglePower,
  openData,
  openProfiles,
  openSSH,
  openTeam,
  openRemote,
}: {
  hosts: ExecutionHostView[];
  open: boolean;
  close: () => void;
  power: PowerStatus | null;
  powerBusy: boolean;
  togglePower: (on: boolean) => void;
  openData: () => void;
  openProfiles: () => void;
  openSSH: () => void;
  openTeam: () => void;
  openRemote: () => void;
}) {
  const states = useSettingsStates(open);
  const profilesState = useProfilesState();
  const go = (next: () => void) => () => {
    close();
    next();
  };
  return (
    <div className="settings-rows">
      {power && !isRemoteBrowser ? (
        <label
          className="settings-row keep-awake"
          title={
            "Prevents this computer from sleeping while a local Claude or Codex session reports it is working. " +
            "The display can still sleep. Needs input, done, exit or a quiet turn longer than 20 minutes releases it. " +
            "Codex needs trusted lifecycle hooks; shell sessions never keep it awake."
          }
        >
          <span className="settings-row-icon" aria-hidden="true">
            <Moon size={14} />
          </span>
          <span className="settings-row-label">
            Keep awake during agent work
          </span>
          <span
            className="settings-row-state keep-awake-status"
            data-active={power.active}
          >
            {!power.enabled
              ? "Off"
              : power.active
                ? `Keeping awake · ${power.sessions.length} ${power.sessions.length === 1 ? "session" : "sessions"} working`
                : "On · idle"}
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={power.enabled}
            disabled={powerBusy}
            aria-label="Keep awake during agent work"
            onChange={(e) => togglePower(e.target.checked)}
          />
        </label>
      ) : null}
      {dictationAvailable() && !isRemoteBrowser ? (
        <SettingsRow
          icon={<Mic size={14} />}
          label="Voice dictation"
          name="Voice dictation settings"
          state={states.dictation}
          onOpen={go(openDictationSettings)}
        />
      ) : null}
      {assistAvailable() && !isRemoteBrowser ? (
        <SettingsRow
          icon={<Sparkles size={14} />}
          label="AI suggestions"
          name="AI suggestions settings"
          state={states.assist}
          onOpen={go(openAssistSettings)}
        />
      ) : null}
      {profilesAvailable() && !isRemoteBrowser ? (
        <SettingsRow
          icon={<KeyRound size={14} />}
          label="Claude profiles"
          state={profilesState}
          onOpen={go(openProfiles)}
        />
      ) : null}
      {window.workspace.ssh && !isRemoteBrowser ? (
        <SettingsRow
          icon={<Server size={14} />}
          label="SSH hosts"
          state={hostsState(hosts)}
          onOpen={go(openSSH)}
        />
      ) : null}
      {window.workspace.team && !isRemoteBrowser ? (
        <SettingsRow
          icon={<Users size={14} />}
          label="Team"
          state={states.team}
          onOpen={go(openTeam)}
        />
      ) : null}
      {window.workspace.remote ? (
        <SettingsRow
          icon={<Smartphone size={14} />}
          label="Remote access"
          name="Remote access settings"
          state={states.remote}
          onOpen={go(openRemote)}
        />
      ) : null}
      {!isRemoteBrowser ? (
        <SettingsRow
          icon={<Database size={14} />}
          label="Workspace data"
          state="Backups, export and history"
          onOpen={go(openData)}
        />
      ) : null}
    </div>
  );
}

function Palette({
  items,
  close,
}: {
  items: {
    id: string;
    label: string;
    hint?: string;
    keywords?: string;
    run: () => void;
  }[];
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = paletteMatches(items, query).slice(0, 40);
  const run = (index: number) => {
    const item = matches[index];
    if (!item) return;
    close();
    item.run();
  };
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <section
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-search">
          <Search size={17} />
          <input
            autoFocus
            placeholder="Search folders, sessions and commands…"
            value={query}
            aria-label="Search folders, sessions and commands"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, matches.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(active);
              }
            }}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="palette-options">
          {matches.map((item, index) => (
            <button
              key={item.id}
              className={index === active ? "active" : ""}
              onMouseEnter={() => setActive(index)}
              onClick={() => run(index)}
            >
              <span>{item.label}</span>
              {item.hint ? <span className="muted">{item.hint}</span> : null}
            </button>
          ))}
          {!matches.length ? (
            <p className="palette-empty">No matches.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
