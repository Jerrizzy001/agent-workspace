import { test } from "node:test";
import assert from "node:assert/strict";
import type { Note, Snapshot } from "../src/shared/contracts.js";
import { mergeSnapshot } from "../src/renderer/snapshot.js";

const project = {
  id: "project",
  name: "Fixture",
  path: "/fixture",
  createdAt: "2026-10-30T12:00:00.000Z",
};
const older: Note = {
  id: "note",
  projectId: project.id,
  title: "Note",
  body: "Before continued typing",
  createdAt: project.createdAt,
  updatedAt: "2026-10-30T12:00:01.000Z",
};
const newer: Note = {
  ...older,
  body: "After continued typing",
  updatedAt: "2026-10-30T12:00:02.000Z",
};
function snapshot(notes: Note[]): Snapshot {
  return {
    projects: [project],
    tasks: [],
    attempts: [],
    sessions: [],
    notes,
    layouts: [],
    boardLanes: [],
    capabilities: [],
  };
}

test("snapshot delivery keeps newer present notes and authoritative incoming fields", () => {
  const incoming = snapshot([older]);
  incoming.capabilities = [{ name: "git", available: true, detail: "incoming" }];
  const merged = mergeSnapshot(snapshot([newer]), incoming);
  assert.deepEqual(merged.notes, [newer]);
  assert.equal(merged.projects, incoming.projects);
  assert.equal(merged.tasks, incoming.tasks);
  assert.equal(merged.attempts, incoming.attempts);
  assert.equal(merged.sessions, incoming.sessions);
  assert.equal(merged.layouts, incoming.layouts);
  assert.equal(merged.capabilities, incoming.capabilities);
  assert.deepEqual(mergeSnapshot(merged, snapshot([newer])).notes, [newer]);
  assert.deepEqual(mergeSnapshot(snapshot([older]), snapshot([newer])).notes, [newer]);
});

test("snapshot delivery never restores removed notes or carries versions across scope clears", () => {
  const removed = mergeSnapshot(snapshot([newer]), snapshot([]));
  assert.deepEqual(removed.notes, []);
  assert.deepEqual(mergeSnapshot(removed, snapshot([older])).notes, [older]);

  const rescoped = { ...older, projectId: "other-project" };
  const incoming = snapshot([rescoped]);
  incoming.projects = [{ ...project, id: rescoped.projectId }];
  assert.deepEqual(mergeSnapshot(snapshot([newer]), incoming).notes, [rescoped]);

  const revoked = { ...snapshot([]), projects: [] };
  assert.deepEqual(mergeSnapshot(snapshot([newer]), revoked), revoked);
  assert.deepEqual(mergeSnapshot(revoked, snapshot([older])).notes, [older]);

  const missingProject = { ...snapshot([older]), projects: [] };
  assert.deepEqual(mergeSnapshot(snapshot([newer]), missingProject).notes, [older]);
});
