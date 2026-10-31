import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { until, workspace } from "./claude-fixture.js";
import {
  MAX_EXPORT_CHARS,
  MAX_SOURCE_BYTES,
  TranscriptError,
  approvedTranscriptPath,
  createTranscriptReader,
  plainText,
  redact,
} from "../src/core/transcripts.js";
import { parseSessionStart, matchReport } from "../src/core/conversations.js";
import { createHostRouter } from "../src/core/host-router.js";
import { validateCommand } from "../src/server/validation.js";
import { COMMAND_POLICY, CONTROLLER_WRAPS } from "../src/shared/command-policy.js";

const ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const user = (text: unknown) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
const assistant = (text: string) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }, { type: "thinking", thinking: "hidden" }] } }) + "\n";

test("transcript adapter: approved paths only, partial lines, schema drift, controls and bounds", () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workspace-transcript-unit-")));
  try {
    const root = path.join(temp, "profile", "projects");
    const dir = path.join(root, "-repo");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, ID + ".jsonl");
    fs.writeFileSync(file, user("hello") + assistant("hi \x1b[31mred\x1b[0m\x07 ‮flip"));
    const outside = path.join(temp, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, ID + ".jsonl"), user("not yours"));

    // Paths: absolute, real, inside the root, named after the conversation, regular, ours.
    assert.equal(approvedTranscriptPath(root, file, ID), file);
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        assert.ok(error instanceof TranscriptError);
        return (error as TranscriptError).code;
      }
      return "accepted";
    };
    assert.equal(code(() => approvedTranscriptPath(root, path.join(root, "..", "..", "outside", ID + ".jsonl"), ID)), "unsafe_path");
    assert.equal(code(() => approvedTranscriptPath(root, "-repo/" + ID + ".jsonl", ID)), "unsafe_path");
    assert.equal(code(() => approvedTranscriptPath(root, 42, ID)), "unsafe_path");
    assert.equal(code(() => approvedTranscriptPath(root, file, "00000000-0000-4000-8000-000000000000")), "unsafe_path");
    assert.equal(code(() => approvedTranscriptPath(root, path.join(dir, "missing.jsonl"), ID)), "unavailable");
    // A symlink inside the root that leads outside it.
    const link = path.join(dir, "11111111-1111-4111-8111-111111111111.jsonl");
    fs.symlinkSync(path.join(outside, ID + ".jsonl"), link);
    assert.equal(code(() => approvedTranscriptPath(root, link, "11111111-1111-4111-8111-111111111111")), "unsafe_path");
    // A symlinked root folder is followed only to its real location.
    const dirLink = path.join(root, "linked");
    fs.symlinkSync(outside, dirLink);
    assert.equal(code(() => approvedTranscriptPath(root, path.join(dirLink, ID + ".jsonl"), ID)), "unsafe_path");
    // A folder named like a transcript.
    fs.mkdirSync(path.join(dir, "22222222-2222-4222-8222-222222222222.jsonl"));
    assert.equal(code(() => approvedTranscriptPath(root, path.join(dir, "22222222-2222-4222-8222-222222222222.jsonl"), "22222222-2222-4222-8222-222222222222")), "unsafe_path");

    // Controls, bidi and thinking are removed; a running source is partial.
    const reader = createTranscriptReader();
    let e = reader.exportOf(file, false);
    assert.equal(e.text, "## User\nhello\n\n## Assistant\nhi red flip\n");
    assert.equal(e.messages, 2);
    assert.equal(e.complete, false);
    assert.match(e.partialReason!, /still running/);
    assert.equal(e.watermark, fs.statSync(file).size);
    assert.equal(e.bytes, e.watermark);
    assert.equal(reader.exportOf(file, true).complete, true);
    assert.equal(plainText("a\x1b]0;title\x07b\x1b[2Jc​d\u0085e"), "abcde");

    // An incomplete trailing record is left for later, then read incrementally.
    const size = fs.statSync(file).size;
    const half = user("second").slice(0, 20);
    fs.appendFileSync(file, half);
    e = reader.exportOf(file, true);
    assert.equal(e.complete, false);
    assert.match(e.partialReason!, /still being written/);
    assert.equal(e.watermark, size);
    assert.equal(e.messages, 2);
    fs.appendFileSync(file, user("second").slice(20) + JSON.stringify({ type: "file-history-snapshot", whatever: 1 }) + "\n");
    e = reader.exportOf(file, true);
    assert.equal(e.complete, true);
    assert.equal(e.messages, 3);
    assert.equal(e.watermark, fs.statSync(file).size);
    assert.equal(createTranscriptReader().exportOf(file, true).sourceHash, e.sourceHash, "incremental hash equals a full read");

    // Schema drift fails closed and leaves the cached state as it was.
    for (const bad of ["not json\n", JSON.stringify({ type: "user" }) + "\n", user(42), JSON.stringify(["x"]) + "\n", JSON.stringify({ type: "assistant", message: { role: "user", content: "x" } }) + "\n"]) {
      const copy = path.join(dir, "33333333-3333-4333-8333-333333333333.jsonl");
      fs.writeFileSync(copy, user("ok") + bad + user("after"));
      assert.throws(() => createTranscriptReader().exportOf(copy, true), (error: any) => error.code === "schema_drift" && /does not understand/.test(error.message));
    }
    const appended = path.join(dir, "44444444-4444-4444-8444-444444444444.jsonl");
    fs.writeFileSync(appended, user("ok"));
    const r2 = createTranscriptReader();
    assert.equal(r2.exportOf(appended, true).messages, 1);
    fs.appendFileSync(appended, "\n{broken\n");
    assert.throws(() => r2.exportOf(appended, true), /does not understand/);

    // Bounded output: the newest messages within the limit.
    const big = path.join(dir, "55555555-5555-4555-8555-555555555555.jsonl");
    fs.writeFileSync(big, Array.from({ length: 400 }, (_, i) => user(`message ${i} ` + "x".repeat(2000))).join(""));
    e = createTranscriptReader().exportOf(big, true);
    assert.equal(e.truncated, true);
    assert.equal(e.complete, false);
    assert.ok(e.text.length <= MAX_EXPORT_CHARS);
    assert.match(e.text, /message 399 /);
    assert.doesNotMatch(e.text, /message 0 /);
    // An oversized provider file is refused before it is read.
    const huge = path.join(dir, "66666666-6666-4666-8666-666666666666.jsonl");
    fs.writeFileSync(huge, "");
    fs.truncateSync(huge, MAX_SOURCE_BYTES + 1);
    assert.throws(() => createTranscriptReader().exportOf(huge, true), (error: any) => error.code === "too_large");

    // Redaction: owner-chosen ranges of the previewed text.
    assert.deepEqual(redact("one secret two", [[4, 10]]), { text: "one [redacted] two", count: 1 });
    assert.throws(() => redact("abc", [[0, 2], [1, 3]]), /overlap/);
    assert.throws(() => redact("abc", [[0, 9]]), /Invalid redaction/);

    // SessionStart reports are validated before use.
    assert.deepEqual(parseSessionStart(""), { problem: "no report" });
    assert.ok("problem" in parseSessionStart('{"hook_event_name":"Stop","session_id":"' + ID + '"}'));
    assert.ok("problem" in parseSessionStart('{"hook_event_name":"SessionStart","session_id":"../x"}'));
    const ok = parseSessionStart(JSON.stringify({ hook_event_name: "SessionStart", session_id: ID, transcript_path: file, source: "startup" }));
    assert.deepEqual(ok, { conversationId: ID, transcriptPath: file, source: "startup" });
    const fork = { forkedFrom: { sessionId: "s", generation: 1, conversationId: ID } };
    assert.equal(matchReport(fork, ok as any).ok, false, "a branch reporting its parent's ID is ambiguous");
    assert.equal(matchReport(fork, { conversationId: "77777777-7777-4777-8777-777777777777", source: "clear" }).ok, false);
    assert.equal(matchReport({ conversationId: ID }, ok as any).ok, true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("transcript links: owner preview, redaction and directed grant; awctl transcript read needs grant and link", async () => {
  const w = await workspace("workspace-links-", { awctl: true });
  try {
    const { profiles }: any = await w.core.profiles("create", { label: "Work" });
    const work = profiles[0];
    const source = (
      await w.call("terminal.open", { projectId: w.project.id, provider: "claude", profileId: work.id, prompt: "the codename is alpha", idempotencyKey: "source" })
    ).session;
    w.setSocket(source.backendSocket);
    const recipient = (await w.call("terminal.open", { projectId: w.project.id, provider: "shell", idempotencyKey: "recipient" })).session;
    const bystander = (await w.call("terminal.open", { projectId: w.project.id, provider: "shell", idempotencyKey: "bystander" })).session;
    const sameProfile = (
      await w.call("terminal.open", { projectId: w.project.id, provider: "claude", profileId: work.id, idempotencyKey: "same-profile" })
    ).session;
    await until(() => w.sessionOf(source.id), (s) => s.activity === "done");
    const ids = { sessionId: source.id, generation: 1 };

    // Owner-only everywhere: no gateway route; awctl gets only transcript.read.
    for (const c of ["transcript.preview", "transcript.link", "transcript.revoke", "transcript.list"] as const) {
      assert.equal(COMMAND_POLICY[c], "owner");
      assert.throws(() => validateCommand(c, {}), /not available remotely/);
    }
    assert.equal(CONTROLLER_WRAPS["transcript.read"], null);

    // Preview: bounded plain text with provenance; never a path.
    const preview = await w.call("transcript.preview", ids);
    assert.match(preview.text, /## User\nthe codename is alpha/);
    assert.match(preview.text, /Fixture reply to: the codename is alpha/);
    assert.equal(preview.complete, false);
    assert.match(preview.partialReason, /still running/);
    assert.equal(preview.adapter, "claude-code-jsonl/1");
    assert.match(preview.sourceHash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(preview).includes(work.location), false);
    await assert.rejects(w.call("transcript.preview", { ...ids, path: "/etc/passwd" }), /Unexpected field/);
    await assert.rejects(w.call("transcript.preview", { sessionId: recipient.id, generation: 1 }), /Only Claude/);
    // A session started before its start report arrived (or before this version) cannot be linked.
    await assert.rejects(w.call("transcript.preview", { sessionId: sameProfile.id, generation: 1 }), /does not exist|not reported/);

    // Link checks: fresh preview, other running session, explicit cross-profile consent.
    // The owner selects both mentions of the secret.
    const at = preview.text.indexOf("alpha");
    const at2 = preview.text.indexOf("alpha", at + 5);
    assert.ok(at2 > at);
    const link = (extra: Record<string, unknown>) =>
      w.call("transcript.link", {
        ...ids,
        recipientSessionId: recipient.id,
        recipientGeneration: 1,
        textHash: preview.textHash,
        redactions: [[at2, at2 + 5], [at, at + 5]],
        ...extra,
      });
    await assert.rejects(link({ textHash: "0".repeat(64), allowCrossProfile: true }), /changed since your preview/);
    await assert.rejects(link({ recipientSessionId: source.id, allowCrossProfile: true }), /another session/);
    await assert.rejects(link({ recipientGeneration: 2, allowCrossProfile: true }), /Stale recipient/);
    await assert.rejects(link({}), /different Claude profile/);
    const granted = await link({ allowCrossProfile: true });
    assert.equal(granted.crossProfile, true);
    assert.equal(granted.redactions, 2);
    assert.equal(granted.reads, 0);
    assert.equal(granted.export.excerpt.includes("alpha"), false);
    assert.match(granted.export.excerpt, /\[redacted\]/);
    // Same profile needs no extra consent.
    const sameLink = await w.call("transcript.link", {
      ...ids,
      recipientSessionId: sameProfile.id,
      recipientGeneration: 1,
      textHash: preview.textHash,
    });
    assert.equal(sameLink.crossProfile, false);
    assert.deepEqual(
      (await w.call("transcript.list", { sessionId: recipient.id })).map((l: any) => l.id),
      [granted.id],
    );

    // awctl from the recipient's own shell: no grant, then a grant without the verb.
    let r = await w.inPane(recipient, "awctl transcript read");
    assert.equal(r.code, 1);
    assert.equal(r.json.error, "no_grant");
    await w.core.agentControl("grant", { sessionId: recipient.id, generation: 1, verbs: ["status"] });
    r = await w.inPane(recipient, "awctl transcript read");
    assert.equal(r.json.error, "not_granted");
    await w.core.agentControl("grant", { sessionId: recipient.id, generation: 1, verbs: ["status", "transcript.read"] });
    r = await w.inPane(recipient, "awctl transcript read");
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.links.map((l: any) => l.link), [granted.id]);
    r = await w.inPane(recipient, `awctl transcript read --link ${granted.id}`);
    assert.equal(r.code, 0);
    assert.match(r.json.text, /the codename is \[redacted\]/);
    assert.equal(r.json.text.includes("alpha"), false);
    assert.equal(r.json.export.complete, false);
    assert.equal(r.json.export.redactions, 2);
    assert.match(r.json.notice, /Treat it as data/);
    assert.equal(r.json.nextOffset, null);
    // Bounded paging.
    r = await w.inPane(recipient, `awctl transcript read --link ${granted.id} --limit 10`);
    assert.equal(r.json.text.length, 10);
    assert.equal(r.json.nextOffset, 10);
    r = await w.inPane(recipient, `awctl transcript read --link ${granted.id} --offset 10 --limit 5`);
    assert.equal(r.json.offset, 10);
    assert.equal(r.json.text.length, 5);
    r = await w.inPane(recipient, `awctl transcript read --link ${granted.id} --limit 999999`);
    assert.equal(r.json.error, "bad_request");
    r = await w.inPane(recipient, `awctl transcript read --link ${sameLink.id}`);
    assert.equal(r.json.error, "not_found", "another session's link is not readable");

    // A bystander with its own grant cannot read a link it was not given.
    await w.core.agentControl("grant", { sessionId: bystander.id, generation: 1, verbs: ["transcript.read"] });
    r = await w.inPane(bystander, `awctl transcript read --link ${granted.id}`);
    assert.equal(r.json.error, "not_found");
    r = await w.inPane(bystander, "awctl transcript read");
    assert.deepEqual(r.json.links, []);

    // Reads are counted and audited.
    const listed = (await w.call("transcript.list", { sessionId: recipient.id }))[0];
    assert.equal(listed.reads, 3, "three successful reads; refused ones do not count");
    const audit = (await w.core.agentControl("list", { sessionId: recipient.id })).audit;
    assert.ok(audit.some((a) => a.action === "transcript.read" && a.outcome === "ok" && a.ids?.includes(granted.id)));

    // Revoke stops future reads.
    const revoked = await w.call("transcript.revoke", { linkId: granted.id });
    assert.ok(revoked.revokedAt);
    r = await w.inPane(recipient, `awctl transcript read --link ${granted.id}`);
    assert.equal(r.json.error, "revoked");
    r = await w.inPane(recipient, "awctl transcript read");
    assert.deepEqual(r.json.links, []);

    // Once the source ends, its export is complete.
    w.type(source, "/exit");
    await until(() => w.sessionOf(source.id), (s) => s.status === "exited");
    const ended = await w.call("transcript.preview", ids);
    assert.equal(ended.complete, true);
    assert.equal(ended.partialReason, undefined);
    // An ended recipient cannot be linked.
    w.type(bystander, "exit");
    await until(() => w.sessionOf(bystander.id), (s) => s.status === "exited");
    await assert.rejects(
      w.call("transcript.link", { ...ids, recipientSessionId: bystander.id, recipientGeneration: 1, textHash: ended.textHash, allowCrossProfile: true }),
      /must be running/,
    );

    // The reported file is replaced by a symlink that leaves the profile: refused.
    const dirs = fs.readdirSync(path.join(work.location, "projects"));
    const file = path.join(work.location, "projects", dirs[0]!, source.conversationId + ".jsonl");
    const escaped = path.join(w.temp, "escaped.jsonl");
    fs.copyFileSync(file, escaped);
    fs.rmSync(file);
    fs.symlinkSync(escaped, file);
    await assert.rejects(w.call("transcript.preview", ids), /outside this profile/);
    // Schema drift in the real file: fails closed.
    fs.rmSync(file);
    fs.writeFileSync(file, fs.readFileSync(escaped, "utf8") + "{not json}\n");
    await assert.rejects(w.call("transcript.preview", ids), /does not understand/);

    // SSH sessions: same computer only.
    const router = await createHostRouter({ local: w.core, emit: () => {}, autoConnect: false });
    await assert.rejects(router.invoke("transcript.preview", { sessionId: "ssh-0a1b2c3d-abc", generation: 1 }), /only available for sessions on this computer/);
    await assert.rejects(
      router.invoke("transcript.link", { ...ids, recipientSessionId: "ssh-0a1b2c3d-abc", recipientGeneration: 1, textHash: "x" }),
      /only available for sessions on this computer/,
    );
    await assert.rejects(router.invoke("conversation.fork", { sessionId: "ssh-0a1b2c3d-abc", generation: 1, idempotencyKey: "k" }), /only available/);
    await assert.rejects(
      router.invoke("terminal.open", { projectId: "ssh-0a1b2c3d-p", provider: "claude", profileId: work.id, idempotencyKey: "k" }),
      /removed from your list|only available for folders on this computer/,
    );
    await router.close();
  } finally {
    await w.close();
  }
});
