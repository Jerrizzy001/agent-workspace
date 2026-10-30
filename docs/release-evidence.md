# Internal alpha evidence

Date: 2026-10-30. Target: macOS arm64. Distribution: unsigned internal build.

## Runtime and dependency spike

- Installed exact Electron 45.1.0, reporting Node 24.22.1 and SQLite 3.53.4.
- `@electron/rebuild` rebuilt node-pty 1.1.0 successfully.
- Electron runtime loaded `node:sqlite`, executed an in-memory version query, and imported the native node-pty module.
- All dependencies are pinned in package-lock.json. DOMPurify 3.4.17 and esbuild 0.28.2 overrides address inherited advisories. npm audit reported zero vulnerabilities after installation.

## Verification commands

`npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke` are separate gates. `npm run smoke` creates an isolated repository and data directory; it performs real Electron preload/utility requests, shell input and capture, git diff, worktree creation, quit/reopen reconciliation and termination. It does not start paid provider calls. Set `WORKSPACE_APP_EXECUTABLE` to the packaged application's executable to run the same check outside the development checkout.

Live provider compatibility, signing/notarization, update delivery, reboot recovery, performance budgets, and long-running soak behavior require additional evidence. Terminal-only provider integration does not establish structured approval handling.

## Observed local acceptance

- `npm run typecheck`: passed.
- `npm test`: 6 tests passed, including persistent metadata/file conflicts/worktrees/session ownership, bounded terminal resync, literal initial prompts, and responsive subprocess execution.
- `npm run build`: passed. Monaco and its workers are bundled locally; the editor remains a large lazy-loaded asset.
- `npm run smoke`: passed using the development Electron executable and built renderer/core.
- Packaged application smoke: passed with `WORKSPACE_APP_EXECUTABLE` pointing to `release/mac-arm64/Agent Workspace.app/Contents/MacOS/Agent Workspace`. Real SQLite/native PTY utility execution, shell input/capture, git diff, worktree creation, explicit quit/reopen preserving the same tmux backend, and termination all passed.

These smoke checks use a disposable repository and synthetic shell output, with an isolated app data directory. They do not establish live Claude or Codex execution or structured provider semantics.
- The packaged `.app` was copied outside the development checkout to `/tmp/agent-workspace-installed-smoke/Agent Workspace.app`; the same acceptance smoke passed there, establishing that the native utility does not depend on development node_modules.

## Visible UI workflow and recovery

`npm run smoke:ui` passed against the final source: task creation and shell attempt launch through visible controls, real xterm keyboard input, board status change, canvas note, locally bundled Monaco load/edit/save. The test killed the exact core service PID and confirmed terminal input after automatic reconnection. With unsaved editor changes, the native close confirmation was set to Keep editing and the window remained open; saving then succeeded. Screenshots of focus, canvas and editor were captured for visual review.
