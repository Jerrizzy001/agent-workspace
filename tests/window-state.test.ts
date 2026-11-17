import { test } from "node:test";
import assert from "node:assert/strict";
import { restoreBounds, WINDOW_DEFAULT } from "../src/desktop/window-state.js";

const laptop = [{ x: 0, y: 25, width: 1512, height: 920 }];
test("window bounds restore only where a display can show them", () => {
  assert.deepEqual(restoreBounds(null, laptop), WINDOW_DEFAULT);
  assert.deepEqual(restoreBounds({ width: "big" }, laptop), WINDOW_DEFAULT);
  assert.deepEqual(
    restoreBounds(
      { x: 40, y: 60, width: 1100, height: 700, maximized: true },
      laptop,
    ),
    { x: 40, y: 60, width: 1100, height: 700, maximized: true },
  );
  const offscreen = restoreBounds(
    { x: 4000, y: 60, width: 1100, height: 700 },
    laptop,
  );
  assert.equal(
    offscreen.x,
    undefined,
    "a window on a disconnected display is re-centred",
  );
  assert.equal(restoreBounds({ width: 300, height: 200 }, laptop).width, 860);
  assert.equal(
    restoreBounds({ width: 5000, height: 3000 }, laptop).width,
    1512,
  );
});
