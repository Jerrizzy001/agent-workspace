import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVITY_LEASE_MS,
  PowerPolicy,
  leaseEnd,
  type PowerSession,
} from "../src/desktop/power-policy.js";
import type { PowerStatus } from "../src/shared/contracts.js";

/** A fake clock, timer queue and blocker so lease expiry is deterministic. */
function harness(enabled = true) {
  let time = 1_800_000_000_000;
  let nextId = 1;
  const active = new Set<number>();
  const log: string[] = [];
  const statuses: PowerStatus[] = [];
  let timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const policy = new PowerPolicy({
    now: () => time,
    blocker: {
      start: () => {
        const id = nextId++;
        active.add(id);
        log.push("start " + id);
        return id;
      },
      stop: (id) => {
        assert.ok(active.delete(id), "stopped an unknown blocker");
        log.push("stop " + id);
      },
    },
    schedule: (run, ms) => {
      const timer = { at: time + ms, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    onStatus: (status) => statuses.push(status),
  });
  if (enabled) policy.setEnabled(true);
  return {
    policy,
    active,
    log,
    statuses,
    now: () => time,
    advance(ms: number) {
      const target = time + ms;
      for (;;) {
        timers = timers.filter((t) => !t.cancelled);
        const due = timers
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        time = due.at;
        due.cancelled = true;
        due.run();
      }
      time = target;
    },
  };
}
const claude = (
  id: string,
  activityAt: number | undefined,
  extra: Partial<PowerSession> = {},
): PowerSession => ({
  id,
  status: "running",
  activityTracking: true,
  activity: "running",
  ...(activityAt !== undefined ? { activityAt } : {}),
  ...extra,
});
const MINUTE = 60_000;

test("overlapping working sessions share exactly one blocker", () => {
  const h = harness();
  const a = claude("a", h.now());
  h.policy.setSessions([a]);
  assert.equal(h.active.size, 1);
  h.advance(5 * MINUTE);
  const b = claude("b", h.now());
  h.policy.setSessions([a, b]);
  assert.equal(h.active.size, 1);
  assert.deepEqual(h.policy.status().sessions, ["a", "b"]);
  // a finishes; b still holds demand.
  h.policy.setSessions([{ ...a, activity: "done" }, b]);
  assert.equal(h.active.size, 1);
  assert.deepEqual(h.policy.status().sessions, ["b"]);
  h.policy.setSessions([{ ...a, activity: "done" }, { ...b, activity: "done" }]);
  assert.equal(h.active.size, 0);
  assert.deepEqual(h.log, ["start 1", "stop 1"]);
  assert.deepEqual(h.policy.status(), {
    enabled: true,
    active: false,
    sessions: [],
  });
});

test("a stale lease expires on its own and a repeated snapshot never renews it", () => {
  const h = harness();
  const a = claude("a", h.now());
  h.policy.setSessions([a]);
  assert.equal(h.policy.status().active, true);
  h.advance(ACTIVITY_LEASE_MS - 1);
  // The same snapshot arriving again (e.g. another session changed) keeps the old report time.
  h.policy.setSessions([a]);
  assert.equal(h.policy.status().active, true);
  h.advance(2);
  assert.equal(h.policy.status().active, false, "timer releases at lease end");
  h.policy.setSessions([a]);
  h.policy.setSessions([{ ...a }]);
  assert.equal(h.active.size, 0);
  assert.equal(leaseEnd(a, h.now()), undefined);
  // A newer hook report (progress) renews it.
  h.policy.setSessions([{ ...a, activityAt: h.now() }]);
  assert.equal(h.active.size, 1);
  assert.deepEqual(h.log, ["start 1", "stop 1", "start 2"]);
});

test("progress reports extend the lease to the newest report", () => {
  const h = harness();
  const start = h.now();
  h.policy.setSessions([claude("a", start)]);
  h.advance(15 * MINUTE);
  h.policy.setSessions([claude("a", h.now())]);
  h.advance(10 * MINUTE);
  assert.equal(h.policy.status().active, true);
  h.advance(10 * MINUTE + 1);
  assert.equal(h.policy.status().active, false);
});

test("needs, done, exit and unknown release the blocker", () => {
  for (const change of [
    { activity: "needs" },
    { activity: "done" },
    { activity: undefined },
    { status: "exited" },
    { status: "unknown" },
  ] as Partial<PowerSession>[]) {
    const h = harness();
    const a = claude("a", h.now());
    h.policy.setSessions([a]);
    assert.equal(h.active.size, 1);
    h.policy.setSessions([{ ...a, ...change }]);
    assert.equal(h.active.size, 0, JSON.stringify(change));
  }
  // A session that disappears from the snapshot also releases.
  const h = harness();
  h.policy.setSessions([claude("a", h.now())]);
  h.policy.setSessions([]);
  assert.equal(h.active.size, 0);
});

test("core disconnect, disable and quit release; nothing is held while disabled", () => {
  const h = harness(false);
  const a = claude("a", h.now());
  h.policy.setSessions([a]);
  assert.equal(h.active.size, 0, "off by default");
  assert.deepEqual(h.policy.status(), {
    enabled: false,
    active: false,
    sessions: [],
  });
  h.policy.setEnabled(true);
  assert.equal(h.active.size, 1);
  h.policy.setSessions(null);
  assert.equal(h.active.size, 0, "core disconnect");
  h.policy.setSessions([a]);
  assert.equal(h.active.size, 1, "reconnect with a still-fresh report");
  h.policy.setEnabled(false);
  assert.equal(h.active.size, 0, "disabled");
  h.policy.setEnabled(true);
  assert.equal(h.active.size, 1);
  h.policy.dispose();
  assert.equal(h.active.size, 0, "quit");
  h.policy.setSessions([claude("a", h.now())]);
  h.policy.setEnabled(true);
  assert.equal(h.active.size, 0, "nothing after quit");
  assert.equal(h.statuses.at(-1)?.active, false);
});

test("untracked providers, missing or future report times are ignored", () => {
  const h = harness();
  h.policy.setSessions([
    // Codex/shell cannot report turns.
    { id: "codex", status: "running", activity: "running" },
    claude("old-build", undefined),
    claude("untracked", h.now(), { activityTracking: false }),
    claude("skewed", h.now() + 10 * MINUTE),
    claude("expired", h.now() - ACTIVITY_LEASE_MS),
  ]);
  assert.equal(h.active.size, 0);
  assert.deepEqual(h.policy.status().sessions, []);
  assert.equal(h.statuses.length, 1, "status emitted only on change");
});
