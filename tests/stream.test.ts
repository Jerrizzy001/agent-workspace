import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminalStream } from "../src/core/stream.js";
import { providerArguments } from "../src/core/providers.js";
import { run } from "../src/core/process.js";
import type { CoreEvent } from "../src/shared/contracts.js";
test("terminal bytes are intact and slow viewer explicitly resynchronizes while healthy viewer continues", () => {
  const events: CoreEvent[] = [];
  const stream = new TerminalStream("session", (event) => events.push(event));
  stream.add("slow");
  stream.add("healthy");
  const frame = "\x1b[?1049h" + "界".repeat(20000) + "\x1b[12;3H";
  for (let i = 0; i < 8; i++) {
    stream.write(frame);
    for (const event of events.splice(0)) {
      if (event.type === "terminal.data") {
        assert.equal(event.data, frame);
        if (event.viewerId === "healthy") stream.ack("healthy", event.sequence);
      } else if (event.type === "terminal.resync") {
        assert.equal(event.viewerId, "slow");
        events.push(event);
      }
    }
  }
  assert.equal(events.filter((e) => e.type === "terminal.resync").length, 1);
  stream.remove("slow");
  assert.throws(() => stream.ack("slow", 0), /not attached/);
  stream.add("slow");
  events.length = 0;
  stream.write("restored");
  assert.equal(events.filter((e) => e.type === "terminal.data").length, 2);
});
test("initial prompts remain literal arguments and shell never executes task text", () => {
  const task = {
    title: "Implement",
    description: "$(touch unwanted)\n`command`",
  };
  assert.deepEqual(providerArguments("codex", task), [
    "--",
    "Implement\n\n$(touch unwanted)\n`command`",
  ]);
  assert.deepEqual(providerArguments("shell", task), []);
  assert.throws(() => providerArguments("claude", task, "\0bad"), /Invalid/);
  // An explicit blank prompt opens the CLI interactively instead of inventing one.
  assert.deepEqual(providerArguments("claude", task, ""), []);
  assert.deepEqual(providerArguments("codex", task, "  \n"), []);
});
test("slow subprocess leaves event loop responsive", async () => {
  let ticked = false;
  const process = run("/bin/sh", ["-c", "sleep 0.1; printf done"]);
  setTimeout(() => {
    ticked = true;
  }, 10);
  assert.equal(await process, "done");
  assert.equal(ticked, true);
});

test("provider model overrides are per-attempt literal arguments with validated syntax", () => {
  const task = { title: "Task", description: "" };
  assert.deepEqual(providerArguments("codex", task, undefined, "gpt-6.1-sol"), [
    "--model",
    "gpt-6.1-sol",
    "--",
    "Task",
  ]);
  assert.deepEqual(providerArguments("claude", task, undefined, "sonnet"), [
    "--model",
    "sonnet",
    "--",
    "Task",
  ]);
  assert.deepEqual(providerArguments("claude", task, undefined, ""), [
    "--",
    "Task",
  ]);
  for (const invalid of [
    null,
    "bad\nmodel",
    "x".repeat(201),
    "--flag",
    "model with spaces",
  ])
    assert.throws(
      () => providerArguments("codex", task, undefined, invalid),
      /Invalid provider model/,
    );
  assert.throws(
    () => providerArguments("shell", task, undefined, "sonnet"),
    /do not support/,
  );
});
test("output acknowledgments cannot release another viewer frame", () => {
  const events: CoreEvent[] = [];
  const stream = new TerminalStream("session", (event) => events.push(event));
  stream.add("a");
  stream.add("b");
  stream.write("frame");
  const a = events.find(
    (e) => e.type === "terminal.data" && e.viewerId === "a",
  ) as Extract<CoreEvent, { type: "terminal.data" }>;
  const b = events.find(
    (e) => e.type === "terminal.data" && e.viewerId === "b",
  ) as Extract<CoreEvent, { type: "terminal.data" }>;
  assert.throws(() => stream.ack("a", b.sequence), /Invalid output/);
  assert.throws(() => stream.ack("b", a.sequence), /does not belong/);
  stream.ack("a", a.sequence);
  stream.ack("a", a.sequence);
});
test("overflow keeps legitimate in-flight acknowledgments valid while rejecting foreign and future frames", () => {
  const events: CoreEvent[] = [];
  const stream = new TerminalStream("session", (event) => events.push(event));
  stream.add("slow");
  stream.add("other");
  stream.write("x".repeat(200000));
  const frames = events.filter(
    (e): e is Extract<CoreEvent, { type: "terminal.data" }> => e.type === "terminal.data",
  );
  const slow = frames.find((e) => e.viewerId === "slow")!;
  const other = frames.find((e) => e.viewerId === "other")!;
  stream.write("y".repeat(100000));
  assert.equal(events.filter((e) => e.type === "terminal.resync").length, 2);
  assert.throws(() => stream.ack("other", slow.sequence), /does not belong/);
  assert.throws(() => stream.ack("slow", other.sequence), /Invalid output/);
  assert.doesNotThrow(() => stream.ack("slow", slow.sequence));
  assert.doesNotThrow(() => stream.ack("other", other.sequence));
  stream.write("paused until reattached");
  assert.equal(events.filter((e) => e.type === "terminal.data").length, 2);
  stream.remove("slow");
  stream.add("slow");
  assert.throws(() => stream.ack("slow", slow.sequence), /Invalid output/);
  stream.write("restored");
  assert.equal(events.filter((e) => e.type === "terminal.data").length, 3);
});
