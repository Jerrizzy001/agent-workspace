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
