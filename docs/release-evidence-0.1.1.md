# Agent Workspace 0.1.1 verification evidence

Date: 2026-10-30. Target: macOS arm64. Distribution: unsigned internal alpha.

## Artifact

- Application: `release/mac-arm64/Agent Workspace.app`.
- Archive: `release/Agent Workspace-0.1.1-arm64-mac.zip` (145,502,727 bytes).
- Archive SHA-256: `9fd673950ba33e3f343f60ab6576279210e449fa9df0a5e9b3c281b7ca9946c8`.
- Bundled `app.asar` SHA-256: `8344a4fdbaa8214949f65fe82dfadd175b7d9f70e60ec02d78ea65bc5561c401`.
- The packaged application was copied outside the checkout to `/tmp/agent-workspace-0.1.1-gca3nS/Agent Workspace.app`. Its `app.asar` hash matched the release application. Every packaged check below used this copied executable with `WORKSPACE_DEV_URL` unset.
- The copied runtime reported application version 0.1.1, `app.isPackaged === true`, Electron 45.1.0, Node.js 24.22.1 and arm64. Electron-builder rebuilt node-pty 1.1.0 for this Electron version. Actual native PTY and SQLite operations passed in the copied application. tmux 3.8 was installed locally; tmux remains an external prerequisite.
- Signing was explicitly disabled. The build uses the default Electron application icon and has no updater.

## Source and dependency gates

- `npm run typecheck`: passed on final source.
- `npm test`: 16/16 passed on final source. Coverage includes durable metadata and worktrees; generation/viewer ownership; literal provider arguments and model overrides; bounded terminal streams and legitimate in-flight acknowledgments; exact ordered xterm rows from a real tmux burst; Git literal filenames, rename/index/unborn-branch behavior; symlink/root boundaries, raw-byte save conflicts and UTF-8 validation; legacy socket recovery; startup failure and real process-crash/concurrent ownership recovery.
- The core reviewer repeated the real SIGKILL/concurrent-process ownership regression ten times successfully before the final full suite.
- `npm audit`: zero vulnerabilities across production and development dependencies.
- `git diff --check`: passed.
- `npm run package`: passed, including the renderer/desktop build and native dependency rebuild. Dependencies are pinned in `package-lock.json`. Vite reports large locally bundled Monaco chunks; no performance budget or size optimization claim is made.

## Packaged acceptance

All runners use disposable repositories and isolated application data. The following copied-application checks passed serially:

| Command | Observed result |
| --- | --- |
| `npm run smoke` | Real preload/utility IPC, SQLite-backed project/task records, native shell input and capture, Git diff, managed worktree creation, explicit quit/reopen of the same backend, and termination. |
| `npm run verify:desktop` | Invalid command/payload rejection, payload size bound, foreign-window bridge rejection, popup denial, three actual killed-core restarts with new core PIDs and unchanged session generation, fourth-crash retry exhaustion with prompt request failure, and reopening the same persistent terminal. |
| `npm run smoke:ui` | Task/attempt controls, actual xterm typing, killed-core recovery, native window-close and application-Quit cancellation for a dirty editor, successful core recovery after the cancelled Quit, board status, canvas note and local Monaco editing/save. |
| `npm run verify:workflows` | 15 workflow groups: task editing/revisions/status; board selection and drag; immediate terminal input/resize; canvas notes/drag/undo/redo; optimistic editor save and cancelled project navigation; external-file conflict/reload; staged/unstaged/untracked diff; stage/unstage/commit; worktree creation; immutable failed-launch retry; distinct attempts/worktrees/sessions; multiple projects; and file editing in a non-Git directory. |
| `npm run verify:lifecycle` | Six groups: injected unknown-state UI reconnects to an actual existing shell without a new attempt; natural/explicit exit remounts without a spinner; independent visible provider model values and blank CLI inheritance; note autosave without blur; and immediate close of a focused note, persistence protection and recovery after application restart. |
| `npm run verify:terminal` | Seven groups: Unicode and ANSI alternate screen; redraw across board/canvas/focus; normal-buffer restoration; distinct ordered final rows matching actual tmux capture; 10,000-line burst followed by successful typing; forced bounded-stream resynchronization with matching rows and no alert/spinner; and a complete command through the terminal's DOM clipboard-paste handler after resync. No system clipboard contents were read. |

The final terminal runner uses key typing and explicitly checks textarea focus. Earlier development checks using CDP `insertText` sometimes failed to deliver complete commands; the final serialized packaged run passed exact row comparisons and subsequent typed/pasted command checks. Screenshots of the copied application's focus/editor, workflow canvas, model modal, reopened focused note and clean resynchronized terminal were independently inspected. A black scrollbar/viewport strip at the terminal bottom remains a cosmetic issue.

Acceptance fixture identifiers: `workspace-smoke-Dm7zu0`, `workspace-desktop-bKBMqg`, `workspace-ui-mjRMFn`, `agent-workflows-YQv3Wo`, `agent-lifecycle-ui-Le19XY`, and `agent-terminal-modes-U8PWFW`. These temporary fixtures are verification records, not application data shipped in the archive. Each runner closes its own application and cleans only its exact fixture's sessions/socket; no global tmux cleanup is used.

To repeat an individual packaged check:

```sh
WORKSPACE_APP_EXECUTABLE="/path/to/Agent Workspace.app/Contents/MacOS/Agent Workspace" npm run smoke
```

Substitute any other local verification command from the table. Run UI checks serially.

## Live packaged provider execution and recovery

`npm run verify:providers` passed once against the final copied application, using existing installed CLI authentication:

| CLI | Explicit per-attempt model | Exact file edit | Execution count after restart | Live process recovery |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.314 | `claude-opus-4-6` | Passed | Exactly one appended line | Same session ID, generation and tmux pane PID |
| Codex CLI 0.166.0 | `gpt-6.1-sol` | Passed | Exactly one appended line | Same session ID, generation and tmux pane PID |

The application created a separate managed worktree for each provider in disposable fixture `workspace-provider-JCCZ0W`. Each real model created the exact requested `provider-proof.txt` and appended one line to `run-count.txt`. The harness detached both views, explicitly quit/reopened the application, and checked unchanged attempt IDs, terminal session IDs, generations and actual pane process IDs. After reopening, both proof files remained exact and both execution counts remained one. This establishes live provider file editing and recovery of the existing interactive CLI process without observed prompt resubmission. The harness then terminated both fixture sessions and closed the application.

The Codex installation update from 0.145.0 to 0.166.0 was explicitly authorized by the user. Claude Code self-updated from 2.1.282 to 2.1.314. No global model/auth settings were manually edited; explicit per-attempt model flags were used. Fixture-only trust prompts were accepted. No permission-bypass flags or billing/extra-usage enablement were used. Provider trust prompts may persist trusted-folder entries through the CLI itself. The application does not install or upgrade provider CLIs.

The live runner consumes provider usage and is intentionally separate from the ordinary test gates:

```sh
WORKSPACE_APP_EXECUTABLE="/path/to/Agent Workspace.app/Contents/MacOS/Agent Workspace" \
WORKSPACE_VERIFY_MODELS='{"claude":"claude-opus-4-6","codex":"gpt-6.1-sol"}' \
npm run verify:providers
```

## Scope and limits

This release implements a local desktop alpha. Remote/mobile access, collaboration, provider conversation resume, structured approval handling, usage accounting, signed/notarized distribution and automatic updates are not implemented. Terminal integration uses the provider's own interactive interface and permissions. The session recovery proven here is continuity of a live tmux-backed process after view remount, core crashes or application quit/reopen; it is not provider conversation reconstruction after process death or reboot.

No reboot test, long-running soak, performance budget, cross-machine install or Intel macOS build was completed. A reboot ends live processes. The checks do not establish every possible terminal program, provider prompt, permission interaction, model, future CLI version or operating-system configuration. Authentication and inference availability still depend on the installed providers and the user's account.
