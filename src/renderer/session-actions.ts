import type { Session } from "../shared/contracts";
import { createId } from "./id";

/**
 * Ends a session's process. The core ends a session only for an attached
 * viewer, so without one a short-lived viewer is attached for the call.
 */
export async function endSession(
  session: Pick<Session, "id" | "generation">,
  viewer: string | null = null,
) {
  const identity = { sessionId: session.id, generation: session.generation };
  const temporary = viewer ? null : createId();
  try {
    if (temporary)
      await window.workspace.invoke("session.attach", {
        ...identity,
        viewerId: temporary,
        cols: 80,
        rows: 24,
      });
    await window.workspace.invoke("session.terminate", {
      ...identity,
      viewerId: viewer || temporary,
    });
  } finally {
    if (temporary)
      void window.workspace
        .invoke("session.detach", { ...identity, viewerId: temporary })
        .catch(() => {});
  }
}
