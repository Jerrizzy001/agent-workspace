# Next agent implementation brief

> **Superseded.** This was the 0.3.0 brief. Start from [handoff.md](handoff.md) for the current state and next work.

> **Status (0.3.0):** the folder-first journey below is implemented: in-app folder browser, one-click Claude/Codex/Shell launch with no task, blank interactive launches, saved final output when a process ends, Claude running/needs-you/done status through per-session hooks, notifications, resume, and right-click canvas creation. See [release-evidence.md](release-evidence.md) for what was and was not verified.
>
> **Still open from the owner's priority list:**
> - Board cards as live sessions (the board still tracks tasks).
> - A product name: the visual identity and icon are new, but "Agent Workspace" is a placeholder.
> - Codex status hooks: untested, because no Codex CLI was available.
> - macOS packaging and verification of 0.3.0.

Improve the UI and everyday functionality of Agent Workspace. The current 0.2.0 build provides a working session core, local desktop app, authenticated browser gateway, and mobile web client. The next iteration should make navigating folders and opening coding agents much more direct.

## User request

The user wants to navigate folders through the app without using terminal commands, then open Claude or Codex by clicking a clearly visible provider button. The current task and attempt workflow adds too much friction to this basic action. They want a different agent to take ownership of improving the UI and functionality.

The primary journey should be:

1. Open the app and browse or choose a folder.
2. See the selected folder and its files clearly.
3. Click **Claude** or **Codex**.
4. Use the resulting interactive terminal in that exact folder.

Task descriptions, board columns, initial prompts, models, and isolated worktrees should be optional tools around that journey. Opening an ordinary agent terminal should not require completing task and attempt forms first.

## Implementation priorities

- Provide discoverable folder navigation: a folder tree or browser, parent navigation, a visible current path, and a clear open/select action. A native folder picker can complement the app's navigation. Basic operation must require no `cd`, manual path commands, or terminal-based repository setup.
- Put distinct **Claude**, **Codex**, and **Shell** launch actions beside the selected workspace. Keep the selected directory visible while switching terminals.
- Launch the installed provider in the selected folder with a single click once that folder is selected. Create internal bookkeeping automatically if the data model still requires a task and attempt. An optional advanced flow can expose the full existing task model.
- Support opening an interactive provider without submitting an invented starter prompt. Only submit an initial model instruction when the user supplies one. Inspect `providerArguments` and the required task relationship before changing this behavior.
- Preserve explicit per-session model selection as an optional control. Current tested models are `gpt-6.1-sol` and `claude-opus-4-6`; installation and account availability must be checked rather than assumed.
- Improve visual hierarchy, navigation, spacing, empty states, and error handling. Folder selection and provider launch should be the obvious primary actions. Give canvas, board, and review views a clear place without making them prerequisites.
- Make running sessions easy to find, switch between, reopen, interrupt, and deliberately end. Switching views must not restart a provider or submit its prompt again.
- Make missing CLI installations, unavailable models, inaccessible directories, non-Git folders, and disconnected hosts actionable in the UI. Avoid inert buttons and mock success states.
- Apply the simplified workflow to narrow browser layouts where the supported host capabilities permit it.

## Architecture and boundaries

| Area | Starting points |
| --- | --- |
| Main UI and launch forms | `src/renderer/App.tsx` |
| Terminal attachment and input | `src/renderer/TerminalView.tsx` |
| File navigation, editing and Git review | `src/renderer/ReviewPanel.tsx` |
| Canvas and notes | `src/renderer/CanvasView.tsx`, `src/renderer/snapshot.ts` |
| Desktop bridge and native picker | `src/desktop/main.ts`, `src/desktop/preload.ts` |
| Shared API | `src/shared/contracts.ts` |
| Sessions, persistence and project services | `src/core/index.ts`, `src/core/git.ts` |
| Provider argument construction | `src/core/providers.ts` |
| Browser connection and authentication | `src/renderer/remote.ts`, `src/renderer/BrowserRoot.tsx` |
| Remote authorization | `src/server/gateway.ts`, `src/server/validation.ts` |

Local desktop folder selection and remote browser filesystem access have different authority. Desktop navigation can use an owner-authorized native selection or a deliberately scoped owner API. A paired browser currently operates within projects shared by the host owner; do not expose arbitrary host paths or desktop management commands just to reproduce the local picker. Explain host-side project registration when a remote capability is unavailable.

Preserve the existing SQLite records and active tmux sessions. Use explicit migrations for any data-model change. Keep detach separate from terminate, maintain generation and viewer checks, and preserve uncertain-outcome handling for launches and input. Do not change global CLI authentication or configuration to make a UI test pass.

Preserve unsaved editor protection, note autosave and stale-snapshot ordering, including canvas unmount/remount and cancellation of a native close. Maintain the gateway's default-off behavior, HTTPS requirements, pairing, revocation, and project/viewer authorization.

## Acceptance criteria

- A new user can select a folder and open Claude, Codex, or a shell entirely through visible controls.
- After folder selection, each provider needs one click to open its interactive terminal; no mandatory task or attempt modal is shown.
- The launched process uses the selected directory. Opening terminals in two different folders keeps their directories and identities separate.
- A blank interactive launch does not manufacture or submit a model prompt.
- Switching between sessions, canvas, board, and files preserves the same backend processes.
- Missing providers, inaccessible folders, and non-Git directories produce clear, recoverable UI states.
- Editing, saving, external-file conflict handling, Git review, and dirty-navigation protection remain usable through the app.
- Desktop and mobile layouts are visually inspected at their intended sizes, and the primary actions remain discoverable with keyboard and touch input.
- Remote controls retain authentication and authorization boundaries; reconnect does not duplicate execution.

## Working and verification guidance

Read the current README and `docs/release-evidence.md` before making claims about what has been verified. The source includes automated local, remote, mobile, lifecycle, terminal, and provider fixtures. Run relevant tests for the actual changes, then build and inspect the packaged app. Use disposable repositories, isolated data directories, and private tmux sockets for tests. Live provider tests consume usage and should stay small and separate from ordinary regression tests.

Useful commands are listed in `package.json`. The source supports explicit `rebuild:desktop` and `rebuild:server` commands for native dependencies. The desktop package and standalone server have separate runtime requirements; test both when shared transport or terminal code changes.

The user requested GPT-6.1 Sol subagents at **high effort or above** for implementation and verification. Continue that setting if delegating work. Do not start a broad rewrite solely for stylistic preference: retain the proven execution core where practical and improve the user journey decisively.

Deliver the implemented UI, regression evidence, updated build and concise notes on any remaining limitations. This is an implementation handoff, not a request for another plan.
