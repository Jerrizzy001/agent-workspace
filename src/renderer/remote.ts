import { createId } from "./id";
import type { Command, CoreEvent, WorkspaceAPI } from "../shared/contracts";

export type RemoteStatus =
  | "checking"
  | "signed-out"
  | "connecting"
  | "connected"
  | "reconnecting";
export interface RemoteState {
  status: RemoteStatus;
  error: string;
  authMode: "pairing" | "password";
}

/** A cookie-authenticated transport. Requests are never queued or replayed. */
class BrowserWorkspace implements WorkspaceAPI {
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private retryCount = 0;
  private listeners = new Set<(event: CoreEvent) => void>();
  private stateListeners = new Set<() => void>();
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private state: RemoteState = {
    status: "checking",
    error: "",
    authMode: "pairing",
  };

  constructor() {
    window.addEventListener("offline", () => {
      // Browsers know about a lost network before TCP's heartbeat times out.
      this.socket?.close();
    });
    window.addEventListener("online", () => {
      if (this.stopped || this.state.status !== "reconnecting") return;
      clearTimeout(this.retry);
      void this.reconnect();
    });
  }

  getState = () => this.state;
  subscribeState = (listener: () => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };
  private update(next: Partial<RemoteState>) {
    this.state = { ...this.state, ...next };
    this.stateListeners.forEach((listener) => listener());
  }
  private emit(event: CoreEvent) {
    this.listeners.forEach((listener) => listener(event));
  }
  subscribe(listener: (event: CoreEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async chooseDirectory() {
    return null;
  }

  async initialize() {
    try {
      const response = await fetch("/api/status", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok)
        throw new Error("The workspace server could not be reached.");
      const status = await response.json();
      this.update({
        authMode: status.authMode === "password" ? "password" : "pairing",
      });
      if (status.authenticated) this.connect();
      else this.update({ status: "signed-out", error: "" });
    } catch (error) {
      this.update({
        status: "signed-out",
        error: String(error instanceof Error ? error.message : error),
      });
    }
  }
  async login(secret: string) {
    const response = await fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret }),
    });
    if (!response.ok)
      throw new Error(
        response.status === 429
          ? "Too many attempts. Wait before trying again."
          : "That pairing code or password was not accepted.",
      );
    this.stopped = false;
    this.retryCount = 0;
    this.update({ status: "connecting", error: "" });
    this.connect();
  }
  async logout() {
    const response = await fetch("/api/logout", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok && response.status !== 401)
      throw new Error(
        "Sign out could not be confirmed. Reconnect and try again.",
      );
    this.stop();
    this.update({ status: "signed-out", error: "" });
  }
  private stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.close();
    this.socket = null;
    this.rejectPending();
  }
  private rejectPending() {
    this.pending.forEach((request) => {
      clearTimeout(request.timeout);
      request.reject(
        new Error(
          "Connection interrupted. The result is uncertain; input was not replayed. Reconnect to inspect the existing session before retrying.",
        ),
      );
    });
    this.pending.clear();
  }
  private connect() {
    if (
      this.stopped ||
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    )
      return;
    const url = new URL("/api/ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    const handshakeTimeout = setTimeout(() => {
      if (socket === this.socket && this.state.status !== "connected")
        socket.close();
    }, 10000);
    socket.onmessage = (message) => {
      if (socket !== this.socket) return;
      try {
        const packet = JSON.parse(String(message.data));
        if (packet.type === "hello" && packet.version === 1) {
          clearTimeout(handshakeTimeout);
          this.retryCount = 0;
          this.update({ status: "connected", error: "" });
          this.emit({ type: "core.status", status: "ready" });
        } else if (packet.type === "event") {
          this.emit(packet.event as CoreEvent);
        } else if (packet.type === "result") {
          const request = this.pending.get(packet.id);
          if (!request) return;
          this.pending.delete(packet.id);
          clearTimeout(request.timeout);
          if (packet.error) request.reject(new Error(packet.error));
          else request.resolve(packet.result);
        }
      } catch {
        this.update({ error: "The server sent an invalid response." });
        socket.close();
      }
    };
    socket.onclose = (event) => {
      clearTimeout(handshakeTimeout);
      if (socket !== this.socket) return;
      if (
        event.code === 1008 &&
        /(?:session (?:revoked|expired)|access revoked)/i.test(event.reason)
      ) {
        this.stop();
        this.update({
          status: "signed-out",
          error: "Your access expired or was revoked. Pair again to reconnect.",
        });
        return;
      }
      this.socket = null;
      this.rejectPending();
      if (this.stopped) return;
      this.update({ status: "reconnecting" });
      this.emit({
        type: "core.status",
        status: "restarting",
        message:
          "Connection lost. Terminal input is paused; commands are never replayed automatically.",
      });
      this.retry = setTimeout(
        () => {
          void this.reconnect();
        },
        Math.min(1000 * 2 ** this.retryCount++, 10000),
      );
    };
    socket.onerror = () => {
      /* onclose owns the retry and pending rejection. */
    };
  }
  private async reconnect() {
    if (this.stopped) return;
    try {
      const response = await fetch("/api/status", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (response.ok && !(await response.json()).authenticated) {
        this.stop();
        this.update({
          status: "signed-out",
          error: "Your access expired or was revoked. Pair again to reconnect.",
        });
        return;
      }
    } catch {
      /* A temporary network outage is retried through the socket. */
    }
    this.connect();
  }
  invoke<T = unknown>(
    command: Command,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    if (
      !navigator.onLine ||
      this.state.status !== "connected" ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return Promise.reject(
        new Error(
          "Disconnected. Wait for reconnection before sending input. Nothing was queued.",
        ),
      );
    if (this.pending.size >= 16)
      return Promise.reject(
        new Error(
          "The connection is busy. Wait for the pending requests to finish.",
        ),
      );
    const id = createId();
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            "The request timed out. Its result is uncertain; inspect the workspace before retrying. Nothing was replayed.",
          ),
        );
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      try {
        this.socket!.send(
          JSON.stringify({ type: "rpc", version: 1, id, command, payload }),
        );
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

export const remoteWorkspace = window.workspace ? null : new BrowserWorkspace();
if (remoteWorkspace) window.workspace = remoteWorkspace;
export const isRemoteBrowser = Boolean(remoteWorkspace);
