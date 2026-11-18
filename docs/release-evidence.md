# Agent Workspace 0.4.0 verification evidence

For later verification, see [0.4.3 layout and appearance](appearance-and-panels.md), [0.4.2 transcript connections](transcript-connect.md) and [0.4.1 voice typing](voice-typing.md). This page preserves the 0.4.0 audit evidence.

Date: 2026-11-02 (America/Toronto), following the November 1 audit. The macOS arm64 app was packaged, exercised in disposable workspaces, installed over the existing local app, and opened successfully. See [the finding-by-finding repair map](ux-repairs.md) and [machine-readable results](screenshots/ux-repairs/verification.json). Earlier evidence is retained in [release-evidence-0.3.0.md](release-evidence-0.3.0.md).

## Verification

Host tools: Node 24.12.0; packaged Electron 45.1.0; macOS arm64. Providers in the test suites are fixtures; no live model-generation call was made. No subagents were used for these repairs.

| Gate | Result |
| --- | --- |
| TypeScript | Passed |
| Automated tests | 128 total: 126 passed, 0 failed, 2 opt-in skipped |
| Packaged UX regression | 14 workflow checks passed, including a saved legacy canvas layout, connect/read/revoke/renew, explicit instruction insertion without Enter, failed-turn UI, note restore, editor keyboard save, task attachment and selected-folder sharing |
| Packaged lifecycle | 6 checks passed: reconnect, final output, End, focused note autosave, cancelled close, persistence through quit/reopen |
| Packaged desktop smoke | 9 checks passed: shell, board, canvas, editor and crash recovery |
| Desktop recovery/IPC | 4 checks passed, including repeated real core crashes and same persistent session/generation |
| General workflow regression | 15 checks passed, including drag, note moves, conflicts, staging, commit, worktrees and non-Git folders |
| Session board | 10 checks passed |
| Agent control | 10 checks passed, including permission refusal, scoped commands, child isolation, revoke and unchanged PIDs |
| Profiles / branches / transcript links | 10 fixture checks passed, including redaction and cross-profile consent |
| AI suggestions | 6 fixture checks passed; no paid calls |
| Team flow | 8 checks passed with two app instances, a fake issuer and ephemeral test credential storage |
| Remote desktop/browser | 7 checks passed: pairing, scope, real shell, reconnect, revoke and default-off restart |
| Terminal fidelity | 7 checks passed, including Unicode, alternate screens, a 10,000-line burst and backpressure/resync |
| Keep awake | 9 checks passed against Electron's blocker API and fixture Claude hooks |
| Packaged SSH + fresh server archive | 10 checks passed on a disposable real OpenSSH server: host-key refusal, probe, connect, folder navigation, shell, connection loss/recovery with the same PID, file edit, Git and detach |
| Standalone archive installation | Fresh `npm ci`, browser pairing, real shell, SSH helper handshake and owner-command refusal passed outside the checkout; team service and its setup guide are included |

The last packaged UX run was repeated after the initial-fit correction and passed all 14 checks. Actual user data was then reopened and its canvas visually inspected; preserved cards fit automatically without moving their stored positions.

## Actual upgrade proof

The installed app remains at the same filesystem location, preserving the application directory identity. Consistent database backups and the previous app contents were kept locally under `release/upgrade-backups/` (ignored by Git).

- Database migrated from schema 8 to 9.
- 35 records before and after; no record IDs missing.
- No changes to existing session identity, generation, project, working directory, backend name or socket.
- Both originally running sessions retained their actual tmux pane process IDs.
- The updated app opened with its local core connected. No existing agent prompt was submitted or replayed.
- The existing failed Claude turn now shows **Check terminal**, because an older CLI process cannot retroactively emit the newly added failure hook. The owner can inspect it and use **More actions → Mark turn idle…**. Its billing/model selection was not changed.

## Artifact fingerprints

| Artifact | SHA-256 |
| --- | --- |
| `Agent Workspace-0.4.0-arm64-mac.zip` | `d0ebdc6e76cf6efdbd81eef9a57726714b883b8eeb9147fe093e5d11a41e77f7` |
| Installed `app.asar` | `4a27a9aa03a02976514314f267c9870715747cecabaaffafcb503bf78928d680` |
| `agent-workspace-server-0.4.0.tar.gz` | `7b8b5a9a5784295162131e804399c309d11ba4bb77544fa4ce956348d4451e62` |

## Screenshots

The screenshots in [screenshots/ux-repairs/](screenshots/ux-repairs/) come from the packaged test app with disposable data and fixture providers. They were visually inspected. They are not captures of the owner's private conversations.

![Connected canvas](screenshots/ux-repairs/02-connected-canvas.png)

![Expanded editor](screenshots/ux-repairs/01-expanded-editor.png)

## Limits

The app is unsigned/not notarized. No physical-phone, microphone-recognition, real two-account isolation, production identity-provider/TLS deployment, or live paid-provider turn was claimed from these checks. Those environments still require the owner's setup. The two skipped automated checks explicitly opt into real Claude usage and real-model dictation.

System credential storage is checked only on an explicit Team setup action, or asynchronously when restoring an existing saved team connection. Unconfigured local workspaces do not initialize Keychain. Native credential APIs were checked against Electron's installed declarations and official documentation; automated team sign-in uses test-only encrypted storage, not a claim of real Keychain login persistence.

## Backend audit remediation — 10 November 2026 (local source)

Scope: the **Backend and core audit** section of [the shared audit](https://claude.ai/artifact/B66LRg283AGHjBBPJYCbo9), applied on `codex/ux-repair`. This is source/build verification with disposable data, not a packaged upgrade or an installed release.

- The SQLite record index invalidates per record, including direct SQL deletes and external writes; rollback failures invalidate cached views. Snapshot note bodies are fetched separately, and note writes require a revision. Desktop IPC and browser event streams use record deltas with epochs/sequences and full resynchronization. The gateway authorizes against its pushed state instead of taking a new snapshot for every command.
- Startup skips ended sessions, including legacy records without a backend socket. Ended history older than 30 days is archived out of live snapshots and can be restored. Tasks and archived notes have revision-checked delete controls; task deletion retains ended sessions and refuses live sessions or published Team mappings.
- Transcript listings index exports once and return bounded excerpts, never full export bodies. Canvas and transcript panels subscribe to link changes instead of polling every five seconds.
- Git status streams without the old 4 MiB exec buffer. Commits have a two-minute subprocess limit and longer end-to-end request limits. tmux has a separate queue. Unknown outcomes remain explicit and are never retried automatically.
- Worktrees expose their location, accept an optional absolute destination, and can be removed only without running/unknown sessions or dirty, untracked, or ignored files. Removal retains the branch and is serialized against launches.
- Codex lifecycle hooks are invocation-local, explicitly target their own tmux pane, and retain Codex's hook-trust review. Tracking begins only after a validated identity report; saved conversation IDs support exact resume. CLI exits still report their exit status. Branching and transcript export remain Claude-only.
- Core crash count resets after one stable minute. Daily online SQLite backups retain seven copies separately from pre-migration backups; owner exports remain until explicitly removed. Workspace data controls expose export, history restoration and deletion.
- Large terminal input is split into bounded Unicode-safe writes, with existing input failure/disconnect rules retained. Fresh workspaces prefer durable tmux sockets when the Unix path limit permits; persisted sockets are preserved. A missing socket reports unknown instead of ended. Settings changes emit an event, new files respect the default mode/umask, and schema 10 removes the unused events table.
- Fixture runners use the actual socket-selection rule. Async bridge predicates use explicit awaited polling; lifecycle/mobile checks fetch note bodies on demand. Mobile screenshots now default to their disposable fixture directory.

Validation: `npm run typecheck`, `npm test` (**139 tests: 137 passed, 2 opt-in skipped**), `npm run build`, `npm run smoke:ui`, `npm run verify:lifecycle`, `npm run verify:workflows`, `npm run verify:mobile` (**15 scenarios**) and `npm run verify:backend` passed. The new data panel screenshot was visually inspected. Build still reports the existing large-chunk warning.

The regressions include 1,000 ended sessions (including legacy socketless records), 200 transcript exports, a 2 MiB note, stale/missing note revisions, scoped delta delivery, independent process queues, streaming over 4 MiB, safe worktree deletion, backup integrity, exact Unicode paste, and loss/recovery of a live tmux socket without changing its process. A Codex fixture verifies working/needs-input/done and exact resume while its hook environment deliberately points to the wrong pane. Installed Codex CLI **0.166.0** accepted the generated configuration and lists stable hooks enabled. No real model turn, physical phone, production SSH host, application packaging, installation, signing, or deployment is established by this remediation.
