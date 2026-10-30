import type { Layout, Note, Snapshot } from "../shared/contracts";

/** Revision first (schema v5; absent reads as 1), then edit time. */
const newerNote = (a: Note, b: Note) =>
  (a.revision ?? 1) !== (b.revision ?? 1)
    ? (a.revision ?? 1) > (b.revision ?? 1)
    : a.updatedAt > b.updatedAt;

export function mergeSnapshot(current: Snapshot, incoming: Snapshot): Snapshot {
  const currentNotes = new Map(current.notes.map((note) => [note.id, note]));
  const currentLayouts = new Map(
    current.layouts.map((layout) => [layout.projectId, layout]),
  );
  const projects = new Set(incoming.projects.map((project) => project.id));
  // Likewise a layout never moves back to an older revision.
  const layouts = incoming.layouts.map((layout): Layout => {
    const previous = currentLayouts.get(layout.projectId);
    return previous &&
      projects.has(layout.projectId) &&
      (previous.revision ?? 1) > (layout.revision ?? 1)
      ? previous
      : layout;
  });
  return {
    ...incoming,
    // Membership and scope come from the incoming snapshot. Only a newer
    // version of a note that is still present may survive an older delivery.
    notes: incoming.notes.map((note) => {
      const previous = currentNotes.get(note.id);
      return previous &&
        previous.projectId === note.projectId &&
        projects.has(note.projectId) &&
        newerNote(previous, note)
        ? previous
        : note;
    }),
    layouts: layouts.every((layout, i) => layout === incoming.layouts[i])
      ? incoming.layouts
      : layouts,
  };
}
