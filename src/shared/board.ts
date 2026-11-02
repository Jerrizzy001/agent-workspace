import type { BoardLane, BoardLanes, Session } from "./contracts.js";

/** Lanes a folder's session board starts with until the owner changes them. */
export const DEFAULT_LANES: readonly BoardLane[] = [
  { id: "next", name: "Ready" },
  { id: "working", name: "In progress" },
  { id: "review", name: "In review" },
  { id: "done", name: "Done" },
];
export const MAX_LANES = 6;
export const LANE_NAME_LIMIT = 40;

/** The folder's stored lanes, or the defaults at revision 0. */
export function lanesFor(
  boards: readonly BoardLanes[] | undefined,
  projectId: string,
): BoardLanes {
  const stored = boards?.find((b) => b.projectId === projectId);
  return (
    stored || {
      projectId,
      lanes: DEFAULT_LANES.map((lane) => ({ ...lane })),
      revision: 0,
    }
  );
}

/**
 * The lane a card shows in. A placed session keeps its lane; an unplaced one
 * is shown (never written) in "Working" while open and "Done" once ended,
 * falling back to the first or last lane when those were removed or renamed away.
 */
export function laneOf(
  session: Pick<Session, "lane" | "status">,
  lanes: readonly BoardLane[],
) {
  if (session.lane && lanes.some((l) => l.id === session.lane))
    return session.lane;
  const fallback = session.status === "exited" ? "done" : "working";
  if (lanes.some((l) => l.id === fallback)) return fallback;
  return session.status === "exited"
    ? lanes[lanes.length - 1]?.id
    : lanes[0]?.id;
}

/** Plain one-line lane name: control, zero-width and bidi characters removed. */
export function laneNameText(value: unknown) {
  if (typeof value !== "string" || value.length > 1024)
    throw new Error("Invalid lane name");
  const name = value
    .replace(/[\p{Cc}\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) throw new Error("A lane needs a name");
  if ([...name].length > LANE_NAME_LIMIT)
    throw new Error(
      `Lane names must be ${LANE_NAME_LIMIT} characters or fewer`,
    );
  return name;
}
