import crypto from "node:crypto";
import fs from "node:fs";
import {
  TEAM_LIMITS,
  plainText,
  type InvitationCreated,
  type MeResult,
  type ProjectRole,
  type TeamBoardEntry,
  type TeamMemberView,
  type TeamSessionTokens,
  type TeamStatus,
  type TeamTaskDetail,
  type TeamTaskPreview,
} from "../shared/team-contracts";
import {
  TeamClientError,
  checkServiceUrl,
  createTeamClient,
  nativeLogin,
  type TeamClient,
} from "../team/client";
import { createTeamSync, type TeamStore, type TeamSync } from "../team/sync";

/**
 * Desktop owner's team connection (`workspace:team`, D only). Runs in the
 * Electron main process: it alone holds the team service session, in
 * OS-backed secret storage, and it alone talks to the team service. The local
 * core keeps mappings, cache, cursor and outbox but never a token; the owner
 * gateway and agent control have no route here.
 */
type StoredTeamSession = { serviceUrl: string; tokens: TeamSessionTokens };
type StorageStatus = { available: boolean; backend: string; detail: string };
export interface SecretStore {
  status(): StorageStatus;
  prepare?(): Promise<void>;
  read(): StoredTeamSession | null | Promise<StoredTeamSession | null>;
  write(value: StoredTeamSession | null): void | Promise<void>;
}

/** Lazy OS encryption. Merely opening a local workspace never opens Keychain. */
export function electronSecretStore(
  safeStorage: Electron.SafeStorage,
  file: string,
  allowBasicForTests: boolean,
): SecretStore {
  if (allowBasicForTests) {
    // Explicit private test-data mode only (guarded in main). This fixture
    // never touches the user's keychain and is not used for real credentials.
    const key = crypto.randomBytes(32);
    return {
      status: () => ({
        available: true,
        backend: "basic_text (test only)",
        detail:
          "Test-only ephemeral encrypted store; no system credentials are accessed.",
      }),
      read() {
        try {
          const raw = fs.readFileSync(file);
          const decipher = crypto.createDecipheriv(
            "aes-256-gcm",
            key,
            raw.subarray(0, 12),
          );
          decipher.setAuthTag(raw.subarray(12, 28));
          return JSON.parse(
            Buffer.concat([
              decipher.update(raw.subarray(28)),
              decipher.final(),
            ]).toString(),
          );
        } catch {
          return null;
        }
      },
      write(value) {
        if (!value) {
          fs.rmSync(file, { force: true });
          return;
        }
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        const body = Buffer.concat([
          cipher.update(JSON.stringify(value)),
          cipher.final(),
        ]);
        fs.writeFileSync(file, Buffer.concat([iv, cipher.getAuthTag(), body]), {
          mode: 0o600,
        });
        fs.chmodSync(file, 0o600);
      },
    };
  }
  let result: StorageStatus = {
    available: false,
    backend: "unchecked",
    detail:
      "Secure storage has not been checked. Check it before signing in to a team.",
  };
  let pending: Promise<void> | undefined;
  let writes: Promise<void> = Promise.resolve();
  const prepare = async () => {
    if (result.available) return;
    if (pending) return pending;
    result = {
      available: false,
      backend: "checking",
      detail: "Checking system credential storage…",
    };
    pending = (async () => {
      try {
        if (!(await safeStorage.isAsyncEncryptionAvailable())) {
          result = {
            available: false,
            backend: "none",
            detail:
              "No secure system credential storage is available. Unlock your keychain or keyring, then check again.",
          };
          return;
        }
        const backend =
          process.platform === "linux"
            ? safeStorage.getSelectedStorageBackend()
            : process.platform === "darwin"
              ? "keychain"
              : "dpapi";
        result =
          backend === "basic_text" || backend === "unknown"
            ? {
                available: false,
                backend,
                detail:
                  "A secure keyring backend could not be confirmed. Team sign-in remains off; unlock a Secret Service keyring or KWallet and check again.",
              }
            : {
                available: true,
                backend,
                detail:
                  "Team credentials are encrypted with system credential storage.",
              };
      } catch {
        result = {
          available: false,
          backend: "none",
          detail:
            "System credential storage could not be opened. Check its permission or lock state and try again.",
        };
      }
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  return {
    status: () => result,
    prepare,
    async read() {
      // The common no-team case must return without initializing OS crypto.
      if (!fs.existsSync(file)) return null;
      await prepare();
      if (!result.available) return null;
      try {
        const decrypted = await safeStorage.decryptStringAsync(fs.readFileSync(file));
        return JSON.parse(decrypted.result);
      } catch {
        return null;
      }
    },
    write(value) {
      // Keep refresh writes ordered with logout so a late encryption result
      // cannot recreate a credential file after the owner disconnects.
      const operation = writes
        .catch(() => {})
        .then(async () => {
          if (!value) {
            fs.rmSync(file, { force: true });
            return;
          }
          await prepare();
          if (!result.available) throw new Error(result.detail);
          const encrypted = await safeStorage.encryptStringAsync(
            JSON.stringify(value),
          );
          fs.writeFileSync(file, encrypted, { mode: 0o600 });
          fs.chmodSync(file, 0o600);
        });
      writes = operation;
      return operation;
    },
  };
}

export interface TeamDesktopOptions {
  store: TeamStore;
  secrets: SecretStore;
  openUrl: (url: string) => Promise<void> | void;
  emit: () => void;
  fetchImpl?: typeof fetch;
  syncIntervalMs?: number;
}

const fieldsOf = (value: unknown, keys: string[], required: string[] = []) => {
  if (value === undefined) value = {};
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(value).length > 16 * 1024
  )
    throw new Error("Invalid team request");
  const v = value as Record<string, any>;
  if (Object.keys(v).some((k) => !keys.includes(k)))
    throw new Error("Unexpected team request field");
  for (const k of required)
    if (v[k] === undefined) throw new Error("Missing " + k);
  return v;
};
const sid = (v: unknown, label: string) => {
  if (typeof v !== "string" || !v || v.length > 128)
    throw new Error("Invalid " + label);
  return v;
};
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function createTeamDesktop(options: TeamDesktopOptions) {
  const { store, secrets } = options;
  let saved: StoredTeamSession | null = null;
  let disposed = false;
  let client: TeamClient | null = null;
  let sync: TeamSync | null = null;
  let me: MeResult | null = null;
  let online = false;
  let lastSyncAt: string | null = null;
  let error: string | null = null;
  const notices: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  let connecting = false;

  function notice(text: string) {
    notices.push(text);
    if (notices.length > 5) notices.shift();
  }
  function attach() {
    if (!saved) {
      client = null;
      sync = null;
      return;
    }
    client = createTeamClient({
      serviceUrl: saved.serviceUrl,
      fetchImpl: options.fetchImpl,
      tokens: () => saved?.tokens ?? null,
      saveTokens: async (tokens) => {
        if (!tokens) {
          // The service refused the session: forget it and require a new sign-in.
          saved = null;
          await secrets.write(null);
          error = "Your team sign-in expired or was revoked. Connect again.";
          return;
        }
        if (!saved) return;
        const previous = saved;
        const next = { serviceUrl: previous.serviceUrl, tokens };
        await secrets.write(next);
        if (saved === previous) saved = next;
      },
    });
    sync = createTeamSync({ client, store });
  }

  async function runSync() {
    if (!sync) return;
    try {
      const result = await sync.sync();
      me = result.me;
      online = !result.offline;
      error = null;
      lastSyncAt = new Date().toISOString();
      for (const _ of result.revoked)
        notice(
          "Your access to a team project ended; its cached tasks and comments were removed from this computer.",
        );
      const link = (await store("state")).link;
      if (link)
        await store("setLink", {
          link: {
            ...link,
            identity: result.me.identity,
            teams: result.me.teams,
            lastSyncAt,
          },
        });
    } catch (e) {
      if (e instanceof TeamClientError && e.code === "offline") online = false;
      else if (e instanceof TeamClientError && e.status === 401) {
        online = false;
        attach();
      } else error = e instanceof Error ? e.message : "Team sync failed";
    } finally {
      options.emit();
    }
  }
  function schedule() {
    clearInterval(timer);
    if (!saved) return;
    timer = setInterval(() => void runSync(), options.syncIntervalMs ?? 15_000);
    timer.unref?.();
  }
  const initialized = Promise.resolve()
    .then(() => secrets.read())
    .then((value) => {
      if (disposed) return;
      saved = value;
      attach();
      if (saved) {
        schedule();
        void runSync();
      }
      options.emit();
    })
    .catch(() => {
      if (disposed) return;
      error =
        "The saved team sign-in could not be restored. Local work is still available.";
      options.emit();
    });

  async function status(): Promise<TeamStatus> {
    const state = await store("state");
    return {
      secretStorage: secrets.status(),
      connected: !!saved && !!state.link,
      serviceUrl: state.link?.serviceUrl ?? saved?.serviceUrl ?? "",
      identity: state.link?.identity ?? null,
      teams: me?.teams ?? state.link?.teams ?? [],
      projects: state.projects,
      outbox: state.outbox,
      lastSyncAt: lastSyncAt ?? state.link?.lastSyncAt ?? null,
      online: !!saved && online,
      error,
      notices: [...notices],
    };
  }
  function api() {
    if (!client || !saved) throw new Error("Connect to a team service first");
    return client;
  }
  async function project(teamProjectId: unknown) {
    const id = sid(teamProjectId, "team project");
    const { projects } = await store("state");
    const p = projects.find((x: any) => x.id === id && x.state === "active");
    if (!p) throw new Error("That team project is not available");
    return p;
  }
  async function preview(taskId: string): Promise<TeamTaskPreview> {
    const local = await store("localTask", { taskId });
    if (!local.teamProject)
      throw new Error("Publish this folder to a team project first");
    if (local.teamProject.role !== "admin")
      throw new Error("Only project admins publish tasks");
    const fields = {
      title: plainText(local.task.title, TEAM_LIMITS.title, "Title", false),
      description: plainText(
        local.task.description ?? "",
        TEAM_LIMITS.description,
        "Description",
      ),
      status: local.task.status,
    };
    const json = JSON.stringify(fields, null, 2);
    return {
      localTaskId: taskId,
      teamProjectId: local.teamProject.id,
      teamProjectName: local.teamProject.name,
      fields,
      json,
      bytes: Buffer.byteLength(json),
      hash: sha(json),
      sharedTaskId: local.map?.shared_task_id ?? null,
    };
  }
  async function detail(sharedTaskId: string): Promise<TeamTaskDetail> {
    const d = await store("task", { sharedTaskId });
    if (!d) throw new Error("That shared task is not available");
    const { projects, link } = await store("state");
    const p = projects.find((x: any) => x.id === d.teamProjectId);
    const team = (me?.teams ?? link?.teams ?? []).find(
      (t: any) => t.id === p?.teamId,
    );
    const meMemberId = team?.memberId ?? null;
    const pending = (d.outbox as any[])
      .filter((o) => o.action === "comment.create" && o.target === sharedTaskId)
      .map(async (o) => {
        const item = await store("outboxItem", { mutationId: o.mutationId });
        return {
          id: o.mutationId,
          taskId: sharedTaskId,
          authorId: meMemberId ?? "",
          authorName: link?.identity?.name ?? "You",
          body: String(item?.payload?.body ?? ""),
          revision: 0,
          createdAt: o.createdAt,
          updatedAt: o.createdAt,
          deleted: false,
          pending: true,
          mine: true,
        };
      });
    return {
      task: d.task,
      role: d.role,
      meMemberId,
      comments: [
        ...d.comments.map((c: any) => ({
          ...c,
          mine: !!meMemberId && c.authorId === meMemberId,
        })),
        ...(await Promise.all(pending)),
      ],
      assignment: d.assignment,
      members: d.members,
      outbox: (d.outbox as any[]).filter((o) => o.target === sharedTaskId),
    };
  }
  /** Mutations are queued first, so an offline change stays visible and is sent later. */
  async function queued<T>(
    sharedTaskId: string,
    fn: (s: TeamSync) => Promise<T>,
  ) {
    api();
    await fn(sync!);
    await runSync();
    return detail(sharedTaskId);
  }

  const handlers: Record<string, (v: unknown) => Promise<unknown>> = {
    status: async (v) => (fieldsOf(v, []), status()),
    prepare: async (v) => {
      fieldsOf(v, []);
      await secrets.prepare?.();
      return status();
    },
    connect: async (v) => {
      const p = fieldsOf(v, ["serviceUrl", "invitation"], ["serviceUrl"]);
      const serviceUrl = checkServiceUrl(p.serviceUrl);
      if (
        p.invitation !== undefined &&
        (typeof p.invitation !== "string" || p.invitation.length > 100)
      )
        throw new Error("Invalid invitation code");
      await secrets.prepare?.();
      const secret = secrets.status();
      if (!secret.available) throw new Error(secret.detail);
      if (connecting) throw new Error("A sign-in is already in progress");
      // Already connected here: an invitation joins without signing in again.
      if (saved && saved.serviceUrl === serviceUrl && p.invitation) {
        await api().call("invitation.accept", { code: p.invitation });
        await runSync();
        return status();
      }
      connecting = true;
      try {
        const tokens = await nativeLogin({
          serviceUrl,
          invitation: p.invitation,
          openUrl: options.openUrl,
          fetchImpl: options.fetchImpl,
        });
        if (saved && saved.serviceUrl !== serviceUrl) await client?.logout();
        saved = { serviceUrl, tokens };
        await secrets.write(saved);
        attach();
        const result = await api().call<MeResult>("me");
        me = result;
        await store("setLink", {
          link: {
            serviceUrl,
            identity: result.identity,
            teams: result.teams,
            connectedAt: new Date().toISOString(),
          },
        });
        error = null;
        online = true;
        await runSync();
        schedule();
        return status();
      } finally {
        connecting = false;
      }
    },
    disconnect: async (v) => {
      fieldsOf(v, []);
      clearInterval(timer);
      await client?.logout();
      saved = null;
      await secrets.write(null);
      attach();
      me = null;
      online = false;
      error = null;
      // Removes this computer's copy of team metadata and anything unsent.
      await store("setLink", { link: null });
      options.emit();
      return status();
    },
    publishProject: async (v) => {
      const p = fieldsOf(
        v,
        ["projectId", "teamProjectId", "teamId", "name"],
        ["projectId"],
      );
      const projectId = sid(p.projectId, "folder");
      let teamProjectId: string;
      if (p.teamProjectId) {
        const tp = await project(p.teamProjectId);
        if (tp.role !== "admin")
          throw new Error(
            "Only project admins can publish a folder's tasks there",
          );
        teamProjectId = tp.id;
      } else {
        const created = await api().call("project.create", {
          teamId: sid(p.teamId, "team"),
          name: plainText(p.name, TEAM_LIMITS.name, "Project name", false),
          mutationId: crypto.randomUUID(),
        });
        teamProjectId = created.id;
        await sync!.revalidate();
      }
      await store("linkProject", { teamProjectId, localProjectId: projectId });
      await runSync();
      return status();
    },
    revokeProject: async (v) => {
      const p = fieldsOf(v, ["projectId"], ["projectId"]);
      const projectId = sid(p.projectId, "folder");
      const { projects } = await store("state");
      const tp = projects.find((x: any) => x.localProjectId === projectId);
      if (!tp) throw new Error("This folder is not published to a team");
      const maps = (await store("taskMaps", { teamProjectId: tp.id })) as any[];
      for (const m of maps) {
        const local = await store("localTask", {
          taskId: m.local_task_id,
        }).catch(() => null);
        const revision = local?.remote?.revision;
        if (revision !== undefined && tp.state === "active")
          await api()
            .call("sharedTask.remove", {
              taskId: m.shared_task_id,
              revision,
              mutationId: crypto.randomUUID(),
            })
            .catch(() => {});
        await store("unmapTask", { localTaskId: m.local_task_id });
      }
      await store("linkProject", {
        teamProjectId: tp.id,
        localProjectId: null,
      });
      await runSync();
      return status();
    },
    previewTask: async (v) =>
      preview(sid(fieldsOf(v, ["taskId"], ["taskId"]).taskId, "task")),
    publishTask: async (v) => {
      const p = fieldsOf(v, ["taskId", "hash"], ["taskId", "hash"]);
      const current = await preview(sid(p.taskId, "task"));
      if (current.hash !== p.hash)
        throw new Error(
          "The task changed after the preview. Review the preview again before publishing.",
        );
      const local = await store("localTask", { taskId: current.localTaskId });
      let shared: any;
      try {
        shared = local.remote
          ? await api().call("sharedTask.update", {
              taskId: local.remote.id,
              revision: local.remote.revision,
              ...current.fields,
              mutationId: crypto.randomUUID(),
            })
          : await api().call("sharedTask.publish", {
              projectId: current.teamProjectId,
              ...current.fields,
              mutationId: crypto.randomUUID(),
            });
      } catch (e) {
        if (e instanceof TeamClientError && e.code === "conflict") {
          await runSync();
          throw new Error(
            "The shared copy changed on the team service since your last sync. It has been refreshed; review the preview and publish again.",
          );
        }
        throw e;
      }
      await store("mapTask", {
        localTaskId: current.localTaskId,
        teamProjectId: current.teamProjectId,
        sharedTaskId: shared.id,
        localRevision: local.task.revision,
        payloadHash: current.hash,
      });
      await runSync();
      const board = (await store("boardInfo", {
        projectId: local.task.projectId,
      })) as Record<string, TeamBoardEntry>;
      return board[current.localTaskId];
    },
    unpublishTask: async (v) => {
      const taskId = sid(fieldsOf(v, ["taskId"], ["taskId"]).taskId, "task");
      const local = await store("localTask", { taskId });
      if (!local.map) throw new Error("This task is not published");
      if (local.remote)
        await api().call("sharedTask.remove", {
          taskId: local.remote.id,
          revision: local.remote.revision,
          mutationId: crypto.randomUUID(),
        });
      await store("unmapTask", { localTaskId: taskId });
      await runSync();
      return status();
    },
    sync: async (v) => {
      fieldsOf(v, []);
      api();
      await runSync();
      return status();
    },
    boardInfo: async (v) =>
      store("boardInfo", {
        projectId: sid(
          fieldsOf(v, ["projectId"], ["projectId"]).projectId,
          "folder",
        ),
      }),
    sharedTasks: async (v) =>
      store("sharedTasks", {
        teamProjectId: (
          await project(
            fieldsOf(v, ["teamProjectId"], ["teamProjectId"]).teamProjectId,
          )
        ).id,
      }),
    taskDetail: async (v) =>
      detail(
        sid(
          fieldsOf(v, ["sharedTaskId"], ["sharedTaskId"]).sharedTaskId,
          "shared task",
        ),
      ),
    members: async (v) => {
      const tp = await project(
        fieldsOf(v, ["teamProjectId"], ["teamProjectId"]).teamProjectId,
      );
      try {
        return await api().call<TeamMemberView[]>("member.list", {
          projectId: tp.id,
        });
      } catch (e) {
        if (e instanceof TeamClientError && e.code === "offline")
          return (await store("cache", { teamProjectId: tp.id })).members;
        if (e instanceof TeamClientError && e.code === "no-access")
          await runSync();
        throw e;
      }
    },
    invite: async (v): Promise<InvitationCreated> => {
      const p = fieldsOf(
        v,
        ["teamProjectId", "role", "email"],
        ["teamProjectId", "role"],
      );
      const tp = await project(p.teamProjectId);
      if (!["admin", "member", "viewer"].includes(p.role))
        throw new Error("Choose a role");
      const created = await api().call<InvitationCreated>("member.invite", {
        projectId: tp.id,
        role: p.role as ProjectRole,
        ...(p.email ? { email: plainText(p.email, 254, "Email", false) } : {}),
      });
      await runSync();
      return created;
    },
    setRole: async (v) => {
      const p = fieldsOf(
        v,
        ["teamProjectId", "memberId", "role"],
        ["teamProjectId", "memberId", "role"],
      );
      const tp = await project(p.teamProjectId);
      const list = await api().call("member.setRole", {
        projectId: tp.id,
        memberId: sid(p.memberId, "member"),
        role: p.role,
      });
      await runSync();
      return list;
    },
    removeMember: async (v) => {
      const p = fieldsOf(
        v,
        ["teamProjectId", "memberId"],
        ["teamProjectId", "memberId"],
      );
      const tp = await project(p.teamProjectId);
      const list = await api().call("member.remove", {
        projectId: tp.id,
        memberId: sid(p.memberId, "member"),
      });
      await runSync();
      return list;
    },
    addComment: async (v) => {
      const p = fieldsOf(v, ["sharedTaskId", "body"], ["sharedTaskId", "body"]);
      const id = sid(p.sharedTaskId, "shared task");
      return queued(id, (s) => s.addComment(id, String(p.body)));
    },
    editComment: async (v) => {
      const p = fieldsOf(v, ["commentId", "body"], ["commentId", "body"]);
      const found = await store("comment", {
        commentId: sid(p.commentId, "comment"),
      });
      if (!found) throw new Error("That comment is not available");
      return queued(found.comment.taskId, (s) =>
        s.editComment(p.commentId, String(p.body)),
      );
    },
    deleteComment: async (v) => {
      const p = fieldsOf(v, ["commentId"], ["commentId"]);
      const found = await store("comment", {
        commentId: sid(p.commentId, "comment"),
      });
      if (!found) throw new Error("That comment is not available");
      return queued(found.comment.taskId, (s) => s.deleteComment(p.commentId));
    },
    assign: async (v) => {
      const p = fieldsOf(v, ["sharedTaskId", "memberId"], ["sharedTaskId"]);
      const id = sid(p.sharedTaskId, "shared task");
      const memberId =
        p.memberId === null || p.memberId === undefined
          ? null
          : sid(p.memberId, "member");
      return queued(id, (s) => s.assign(id, memberId));
    },
    resolve: async (v) => {
      const p = fieldsOf(v, ["mutationId", "choice"], ["mutationId", "choice"]);
      if (p.choice !== "retry" && p.choice !== "discard")
        throw new Error("Choose retry or discard");
      api();
      await sync!.resolve(sid(p.mutationId, "change"), p.choice);
      await runSync();
      return status();
    },
  };
  return {
    async handle(action: unknown, value: unknown) {
      if (typeof action !== "string" || !Object.hasOwn(handlers, action))
        throw new Error("Unsupported team action");
      if (disposed) throw new Error("Team connection is closed");
      if (action !== "status") await initialized;
      if (disposed) throw new Error("Team connection is closed");
      return handlers[action]!(value);
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}
