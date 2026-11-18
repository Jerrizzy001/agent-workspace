import assert from "node:assert/strict";
/** Unlike waitForFunction, explicitly await bridge/clipboard promises on each poll. */
export async function pollFunction(
  page,
  predicate,
  argument,
  timeout = 20_000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, argument)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for ${predicate.toString().slice(0, 300)}`);
}

/** Explicitly hydrate notes only in checks that inspect durable note bodies. */
export async function workspaceSnapshotWithNotes() {
  const state = await window.workspace.invoke("snapshot");
  return {
    ...state,
    notes: await Promise.all(
      state.notes.map((note) =>
        window.workspace.invoke("note.read", { noteId: note.id }),
      ),
    ),
  };
}
