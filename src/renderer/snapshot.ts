import type { Snapshot } from "../shared/contracts";

export function mergeSnapshot(current: Snapshot, incoming: Snapshot): Snapshot {
  const currentNotes = new Map(current.notes.map((note) => [note.id, note]));
  const projects = new Set(incoming.projects.map((project) => project.id));
  return {
    ...incoming,
    // Membership and scope come from the incoming snapshot. Only a newer
    // version of a note that is still present may survive an older delivery.
    notes: incoming.notes.map((note) => {
      const previous = currentNotes.get(note.id);
      return previous &&
        previous.projectId === note.projectId &&
        projects.has(note.projectId) &&
        previous.updatedAt > note.updatedAt
        ? previous
        : note;
    }),
  };
}
