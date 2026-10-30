import type { PowerStatus, Session } from "../shared/contracts";
/** A working report keeps the computer awake for at most this long without a newer report. */
export const ACTIVITY_LEASE_MS = 20 * 60 * 1000;
/** Reports stamped further ahead than this (clock skew) are not trusted. */
const FUTURE_SLACK_MS = 60 * 1000;
export type PowerSession = Pick<
  Session,
  "id" | "status" | "activity" | "activityTracking" | "activityAt"
>;
/** When this session's working lease ends, or undefined when it holds no demand at `now`. */
export function leaseEnd(s: PowerSession, now: number): number | undefined {
  if (
    s.status !== "running" ||
    !s.activityTracking ||
    s.activity !== "running" ||
    typeof s.activityAt !== "number" ||
    !Number.isFinite(s.activityAt) ||
    s.activityAt > now + FUTURE_SLACK_MS
  )
    return undefined;
  const end = s.activityAt + ACTIVITY_LEASE_MS;
  return end > now ? end : undefined;
}
export interface Blocker {
  start(): number;
  stop(id: number): void;
}
export interface PowerPolicyOptions {
  blocker: Blocker;
  now?: () => number;
  /** Schedules a re-evaluation; returns a cancel function. */
  schedule?: (callback: () => void, ms: number) => () => void;
  onStatus?: (status: PowerStatus) => void;
}
/**
 * Holds at most one blocker while enabled and at least one local session has a
 * fresh working report. Sessions come only from authoritative core snapshots;
 * `null` means the core is disconnected and nothing is known.
 */
export class PowerPolicy {
  private enabled = false;
  private sessions: PowerSession[] | null = null;
  private blockerId: number | undefined;
  private working: string[] = [];
  private cancel: (() => void) | undefined;
  private disposed = false;
  private last = "";
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, ms: number) => () => void;
  constructor(private readonly options: PowerPolicyOptions) {
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ??
      ((callback, ms) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      });
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.evaluate();
  }
  /** Replaces the observed sessions with a core snapshot's; `null` when the core is unavailable. */
  setSessions(sessions: readonly PowerSession[] | null) {
    this.sessions = sessions
      ? sessions.map(({ id, status, activity, activityTracking, activityAt }) => ({
          id,
          status,
          activity,
          activityTracking,
          activityAt,
        }))
      : null;
    this.evaluate();
  }
  status(): PowerStatus {
    return {
      enabled: this.enabled,
      active: this.blockerId !== undefined,
      sessions: [...this.working],
    };
  }
  evaluate() {
    this.cancel?.();
    this.cancel = undefined;
    const now = this.now();
    let next: number | undefined;
    const working: string[] = [];
    if (this.enabled && !this.disposed)
      for (const s of this.sessions ?? []) {
        const end = leaseEnd(s, now);
        if (end === undefined) continue;
        working.push(s.id);
        next = next === undefined ? end : Math.min(next, end);
      }
    this.working = working;
    if (working.length && this.blockerId === undefined)
      this.blockerId = this.options.blocker.start();
    else if (!working.length && this.blockerId !== undefined) {
      const id = this.blockerId;
      this.blockerId = undefined;
      this.options.blocker.stop(id);
    }
    if (next !== undefined)
      this.cancel = this.schedule(() => this.evaluate(), next - now + 1);
    const status = this.status();
    const key = JSON.stringify(status);
    if (key !== this.last) {
      this.last = key;
      this.options.onStatus?.(status);
    }
  }
  /** Releases the blocker for good (app quit). */
  dispose() {
    this.disposed = true;
    this.evaluate();
  }
}
