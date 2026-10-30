# Agent Workspace 0.3.0 verification evidence

Date: 2026-10-30. Status: development build of the session-first redesign. No macOS release artifact was produced or verified for 0.3.0; the 0.2.0 macOS evidence remains in [release-evidence-0.2.0.md](release-evidence-0.2.0.md).

## Where this was verified

A Linux x86_64 container: Node.js 24.22.2, Electron 45.1.0 under Xvfb (launched through a `--no-sandbox` wrapper because the container runs as root), tmux 3.4, Git, and the Chromium bundled with Playwright. The terminal fixtures need a UTF-8 locale (`LANG=C.UTF-8`); without it tmux renders non-ASCII characters as `_`. node-pty 1.1.0 was compiled from source against local Node headers because the environment's network policy blocks Electron's header host. node-pty uses N-API, so the same build loads in both Node and Electron.

Nothing here was run on macOS, a physical phone, or with a signed build.

## What changed and how it was checked

- **One-click sessions in a chosen folder.** A new `terminal.open` command launches Claude, Codex or a shell in a folder or subfolder without a task or attempt. Retrying with the same idempotency key returns the same session. Paths are scoped to the registered folder; files, missing folders and unreadable folders produce specific messages. Covered by `tests/launch.test.ts` with fixture CLIs in real tmux.
- **No invented prompts.** A blank launch passes no prompt argument. A first message the user supplies is passed once, literally, after `--`. Task attempts still default to the task text, and clearing the field now launches interactively. Covered by `tests/launch.test.ts` and `tests/stream.test.ts`.
- **Startup failures are visible.** The private tmux server sets `remain-on-exit`. When a process ends, its final screen and exit status are saved as a transcript before the tmux session is removed. Previously, a CLI that exited at startup produced a raw `set-option` tmux error, lost its own message, and left the launch receipt unresolved ("Launch outcome unknown"). A probe against 0.2.0 reproduced this, and the launch test now checks the fixed behaviour. A deliberate **End** keeps the old behaviour: no transcript.
- **Agent status.** When the installed Claude CLI lists `--settings` and `--session-id` in `--help`, each Claude session gets:
  - its own conversation ID;
  - per-session hooks that write running, needs-you or done into a tmux pane option, which the core reads every 2 seconds.

  No global CLI configuration is changed. In the fixture test, a CLI ran the exact `Notification` hook command it was given inside a real tmux pane, and the session reported `needs`. Codex and shell sessions report running or ended only.
- **Resume.** An ended Claude session relaunches with `--resume <conversation id>` in its original folder. For Codex, **Resume…** opens Codex's own `codex resume` picker. The Codex path is unverified because no Codex CLI was available.
- **Desktop folder navigation.** A new owner-only `workspace:browse` IPC lists host folders for the in-app browser. The remote gateway has no route to it, and it still rejects `project.add` and the new `project.hide`. Covered by the folder-listing test in `tests/services.test.ts` and gateway assertions in `tests/server.test.ts`.
- **CLI discovery.** The desktop app adds the PATH from the user's login shell, plus `~/.volta/bin` and `~/.bun/bin`, so CLIs installed through nvm, Volta or Bun are found when the app is opened from the Dock. This is untested on macOS.
- **Schema.** The workspace database moves from version 1 to 2 through an explicit migration. Existing rows are unchanged. Older builds refuse version 2 data rather than misread sessions that have no attempt.

## Automated results

- `npm run typecheck`: passed.
- `npm test`: 31 of 31 passed. This is the original 29, plus the folder-launch test and the owner folder-listing test.
- Electron desktop checks were rewritten for the new interface where they relied on the task-first interface:

  | Check | Result |
  | --- | --- |
  | `smoke` | passed |
  | `smoke:ui` | 9 checks passed |
  | `verify:desktop` | 4 checks passed |
  | `verify:workflows` | 15 checks passed |
  | `verify:lifecycle` | 6 checks passed |
  | `verify:terminal` | 7 checks passed |
  | `verify:remote-desktop` | 7 checks passed |

  In the back-to-back final pass, `verify:terminal` timed out once at its deliberately blocked-renderer resync step, then passed all 7 checks in 3 of 3 standalone reruns.
- Browser check: `verify:mobile` passed 14 checks against the headless host with Playwright Chromium. Phone screenshots and `mobile-verification.json` in `screenshots/remote/` were regenerated for 0.3.0.
- Packaged check: `smoke` and `smoke:ui` passed against an unpacked Linux package (`electron-builder --linux dir`, `app.isPackaged === true`, version 0.3.0).

Results are in [screenshots/desktop/verification.json](screenshots/desktop/verification.json). Desktop screenshots of the new interface are in `screenshots/desktop/`; each was inspected.

## Live provider check

The real Claude Code 2.1.314 CLI was opened blank in a disposable folder by the core, with an isolated empty `HOME` and no credentials. It accepted `--session-id` and the hook `--settings`, and showed its own first-run screen in the chosen subfolder. Nothing was typed or submitted, and no model usage occurred. A full model turn firing the hooks inside real Claude Code was not run. The Codex CLI was not installed, so no live Codex check was possible.

## Not run for 0.3.0

macOS packaging (`npm run package`), `verify:mobile-webkit`, `verify:server-release`, `verify:linux-server` (Docker), and the opt-in live scripts `verify:providers` and `verify:remote-provider`.

## Reproduction notes

Browser scripts accept `WORKSPACE_BROWSER=/path/to/chromium` as an alternative to installed Google Chrome. Desktop scripts accept `WORKSPACE_APP_EXECUTABLE` for a packaged or wrapped Electron executable. Tests still default to `/opt/homebrew/bin/tmux` in places; on Linux, point that path at the system tmux or set `WORKSPACE_TMUX`.
