import { powerMonitor, powerSaveBlocker } from "electron";
import { PowerPolicy } from "./power-policy";
import type { PowerStatus } from "../shared/contracts";
/** The app's single power-save blocker: the display may sleep, the system may not suspend. */
export function createPowerController(onStatus: (status: PowerStatus) => void) {
  const policy = new PowerPolicy({
    blocker: {
      start: () => powerSaveBlocker.start("prevent-app-suspension"),
      stop: (id) => {
        if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
      },
    },
    onStatus,
  });
  // Timers may not fire on time across a suspend; recheck leases against the wall clock.
  powerMonitor.on("resume", () => policy.evaluate());
  return policy;
}
