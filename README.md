# Agent Workspace

An independently authored desktop and remote browser app for running coding agents. Pick a folder, click **Claude**, **Codex** or **Shell**, and work in a persistent terminal in that exact folder. Sessions keep running while you switch folders and views, and after you close the window. A spatial canvas, an optional task board, file editing and Git review live around those sessions. They are never a step you have to complete first.

![Folder browser](docs/screenshots/desktop/folder-browser.png)

Version **0.4.0** addresses the end-to-end UX audit. See [the repair map and evidence](docs/ux-repairs.md). Continuing development? Start with [docs/handoff.md](docs/handoff.md).

## Using it

1. **Open a folder.** Browse inside the app, paste a path into **Folder location**, or use the system picker. No terminal commands are needed to navigate. **Remove from list** hides a folder without deleting its files or history.
2. **Start an agent.** Click **Claude**, **Codex** or **Shell**. A blank launch submits no prompt. **Launch options** selects a model, Claude profile or worktree; model availability is checked by the provider, not guessed by the app.
3. **Connect agents on Canvas.** Click **Connect agents**, or drag from a Claude card's outgoing handle to a running recipient. Choose the source, preview/redact its conversation, choose a recipient, and explicitly approve read access. The resulting line identifies source, recipient and read status. Click its label to inspect or revoke it. Connections share immutable snapshots; they do not continuously sync conversations or start work automatically.
4. **Use the shared context.** After connecting, choose **Open recipient with instructions**, then **Insert instructions**. Nothing is submitted until you press Enter. A shell receives the read command; an agent receives a plain-language request. New read permission lasts 15 minutes. Existing permissions and expiry are preserved. Quitting or restarting the core revokes grants; the connection then shows **Reading paused**. Click its label and **Enable recipient reading** to approve access again.
5. **Organize the canvas.** **Add to canvas** adds a terminal or note. Card **Actions** rename, move with buttons, hide a terminal, or archive a note. **Undo removal** and **Hidden & archived** restore them. Hidden terminals keep running. Ended sessions stay out of the way until **Show ended** is checked. **Open terminal** expands a card into the full terminal view.
6. **Track work.** Board has standalone **Sessions** and planned **Tasks**. Both use consistent stage names. A stage is your organizational choice; the runtime badge reports the process separately. In a task, **Attach existing session** connects work already running without launching a duplicate, or **Start an attempt** starts another agent.
7. **Edit and review.** Open a file in **Files**, use **Expand** for a larger editor, and save with `⌘S` / `Ctrl+S` or **Save**. **Changes** previews/stages changes and commits only what you explicitly stage. Worktree cards offer **Open files here** and one-click agent launches in that isolated copy.
8. **Finish or recover.** **Interrupt** sends Ctrl+C; **End** confirms termination and retains a final screen. Normal exits load their final output immediately. **More actions** holds branching and agent permissions. Claude API failures show **Turn failed**. An old activity report shows **Check terminal**; after inspecting an older session, **Mark turn idle…** provides an explicit recovery path without killing it. It must not be used while Claude is still working.
9. **Set up optional tools.** Open **Settings & connections** for voice, suggestions, accounts, SSH, teams and phone access. Command search (`⌘K` / `Ctrl+K`) finds these actions too.

**Accounts:** A profile is a configuration folder, not a guarantee of independent credentials. **Check account** runs the installed Claude CLI's authentication-status command and displays only its reported identity and sign-in status; tokens are never returned or saved by this check. macOS Keychain and environment-level credentials may be shared across profiles. Sign-in still happens in Claude's own terminal.

**Voice and images:** Local English voice dictation types phrases without Enter; **Test microphone** checks input for ten seconds without saving audio or typing text. Models are downloaded explicitly in voice settings. **Paste image** previews a clipboard image, saves a private PNG, and inserts its escaped path without Enter. Remote browsers cannot access the host microphone or clipboard.

**Agent permissions:** **More actions → Agent control**, or a canvas card's **Actions**, offers read-only context and canvas-organization presets plus individual permissions. Access is scoped to one session and folder. Agents use the local `awctl` utility; it cannot type into terminals, terminate processes, change files/Git, or grant more permissions. Opened child sessions inherit no grant. Unknown mutation outcomes retain the original request ID for reconciliation.

**Connections are different:** Canvas connections share reviewed agent context; **SSH** runs work on another host; **Remote access** controls this host from a browser; **Team** shares selected task metadata, comments and assignments. Their setup screens explain prerequisites before enabling access. A tunnel/HTTPS endpoint, SSH host/helper or team service is not provisioned automatically. The server archive includes the SSH helper, team service and its setup guide.

## Run

Requires macOS, Node.js 24+, Git, and tmux (`brew install tmux`). Development and the automated checks also run on Linux with tmux and a UTF-8 locale. Claude and Codex commands use your existing installed CLI authentication. The app never installs providers or changes their global configuration.

```sh
npm ci
npm run dev
```

`npm run build` creates the renderer and Electron entrypoints. `npm run typecheck` checks TypeScript. `npm test` runs the integration tests. `npm run package` creates an unsigned internal macOS application and zip in `release/`. Open the application in `release/mac-arm64/Agent Workspace.app` on Apple silicon. Build on the target architecture.

Before upgrading an existing workspace database, the app saves a consistent copy to `backups/workspace-v<old version>-<time>.sqlite` in its data folder and keeps the newest three. To roll back, quit the app, replace `workspace.sqlite` with that copy and delete `workspace.sqlite-wal` and `workspace.sqlite-shm`, then run the matching older build. A database written by a newer version is refused unchanged.

## Remote browser access

In the desktop header, choose **Remote access**. Access starts off and remains off after each app restart. Keep the default loopback listener for an HTTPS tunnel, or choose network interfaces with a browser-trusted TLS certificate and private key through the native pickers. A network listener requires its exact HTTPS browser origin. Enable the gateway, open the displayed address on your other device, and reveal the pairing code locally to pair it. **Revoke all devices** closes active browser connections and rotates the code; **Stop remote access** detaches browsers while terminal processes continue.

Paired devices can control terminals and edit files in the projects registered when the gateway started. Stop and enable remote access again after adding a desktop project to include it. Browser authentication expires after 12 hours or when the gateway restarts. Keep the host awake and app running. For access anywhere, configure your own HTTPS private-network proxy, such as [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), to forward to the loopback listener with WebSocket support and preserved Host/Origin headers. This app does not install external services or publish a public endpoint. The browser origin must match the configured public address exactly. The source package's [standalone server guide](docs/server-README.md) includes the host and HTTPS setup.

For a separate Mac or Linux server, extract `release/agent-workspace-server-<version>.tar.gz`, then run `npm ci` and `npm start -- --data-dir /absolute/path/to/data --project /absolute/path/to/git-project --host 127.0.0.1 --port 8787`. This distribution includes browser assets and its own Node-only package lock; it has no Electron install or rebuild hooks. `npm run package:server` recreates it. Native dependencies install on the destination host, which requires Node 24+, Git and tmux. Do not run desktop and server cores against the same data directory. The same archive is the SSH helper (`bin/aw-ssh-helper`, see **Work on another computer over SSH** above).

To run the host from source, use `npm run build:server`, `npm run rebuild:server`, then `npm run start:server -- --project /absolute/path/to/git-project`. Use `npm run rebuild:desktop` before returning to Electron if you changed the native build. The standalone archive installs its native dependency for Node directly.

The responsive browser has a folder and session drawer, bottom navigation, the same one-tap Claude/Codex/Shell launch inside shared folders, a terminal command bar, and installable PWA metadata. Browser install support depends on platform and HTTPS. The open app shows connection status and reattaches when the host returns. A fresh offline launch is not supported. Physical iPhone/Android hardware and external network routes have not been verified in this release.

## Persistence and recovery

Version 0.4.0 uses schema **9** (`ux_canvas_and_session_lifecycle`). The ordered migrations preserve existing records and backend identities: folder sessions (2), owner utilities (3), board lanes (4), agent control (5), SSH hosts (6), conversations (7), team metadata (8), then reversible canvas visibility and lifecycle metadata (9). A populated database receives a consistent SQLite backup before migration. Older app versions refuse newer data rather than silently dropping fields.

The core owns the database; tmux owns live processes. Closing the window or quitting the app detaches views while sessions keep running. The desktop recovers from a bounded number of core crashes, then asks for an app restart. Reconnect never resubmits uncertain terminal input or repeats a launch with a new identity. Session creation and worktree operations retain their idempotency checks. Unsaved file edits and pending note writes guard navigation and quit.

## Alpha scope

Execution stays on the selected host. A browser on a phone or another computer can control registered projects through an explicitly enabled authenticated gateway. Terminal output can contain sensitive information and is visible to paired devices. Provider terminals do not imply structured approval handling, conversation resume, usage accounting, or multi-user collaboration. Agent execution uses the same permissions as the desktop user. Terminate a session deliberately from the interface when it should stop.

The internal build is unsigned and has no updater. Packaging and runtime test evidence belongs in `docs/release-evidence.md`.

## Verification

The local fixture runners use disposable repositories and isolated app data. `npm run smoke` checks the desktop/core bridge; `npm run smoke:ui` checks visible controls, editor saving and native close cancellation. `npm run verify:desktop` tests IPC rejection and the bounded core restart policy. `npm run verify:workflows`, `npm run verify:board`, `npm run verify:lifecycle`, `npm run verify:keep-awake` and `npm run verify:terminal` exercise the remaining UI workflows and terminal fidelity. `npm run verify:dictation` checks local voice dictation. `npm run verify:agent-control` grants a shell agent control and drives `awctl` from inside it. `npm run verify:accounts` creates two Claude profiles, opens one session per profile, branches a conversation and links a redacted transcript to a shell that reads it with `awctl`, all with a fixture `claude` (no provider is called). `npm run verify:ssh` starts a disposable local `sshd` (its own keys and config in a temp folder; needs OpenSSH's `sshd`) and drives an SSH host end to end: unknown host key, probe, connect, a remote folder, a remote shell across a killed connection, a remote file edit and Git status. Set `WORKSPACE_VERIFY_SSH_ARCHIVE` to a server archive to install the helper from it with `npm ci` instead of from this build. `npm test` includes SSH tests that use the same kind of disposable `sshd` and skip when it is not installed. `npm run verify:remote-desktop` checks remote authentication, the shared desktop utility core and shell identity, revoke, gateway shutdown and core recovery. `npm run verify:mobile` checks responsive browser workflows with installed Chrome; `npm run verify:mobile-webkit` uses a Playwright WebKit installation for the HTTPS touch fixture. `npm run verify:server-release` installs and tests a fresh standalone archive outside this checkout. `npm run verify:linux-server` tests the archive in an isolated, unprivileged Docker Linux host with loopback-published HTTPS; use `WORKSPACE_DOCKER_HOST` if Docker needs an explicit connection. Build before running them. Set `WORKSPACE_APP_EXECUTABLE` to an application executable to run the same checks against a packaged copy. `npm run verify:assist` checks AI suggestions with a fixture `claude` (no provider is called); `WORKSPACE_TEST_REAL_ASSIST=1 npm test` adds one opt-in real Claude request that can use your usage. `npm run verify:team` starts a local fake OIDC issuer and a team service, then drives two desktop instances: the owner connects, publishes a task after its preview, invites a member, the member comments and takes the task, and the owner removes the member, whose copy of the project is then purged. It needs only Node and Electron, no external services.

`npm test` includes a folder-launch test that uses fixture CLIs in real tmux. It covers blank interactive launch, folder isolation, an idempotent retry, hook-driven needs-you status, saved startup-failure output and resume. Browser scripts accept `WORKSPACE_BROWSER=/path/to/chromium` instead of installed Chrome. `npm run make-icons` regenerates the app and browser icons from the brand mark. Current verification evidence is in [docs/release-evidence.md](docs/release-evidence.md).

`npm run verify:dictation` drives dictation with Chromium's fake microphone playing a WAV synthesised by `espeak-ng`. By default it installs the real tiny.en model through the settings dialog. Set `WORKSPACE_TEST_DICTATION_ARCHIVE` to a local copy of the release asset to skip the network (the pinned checksum still applies), or set `WORKSPACE_VERIFY_DICTATION_FIXTURE=1` to use a fixture transcriber. `WORKSPACE_TEST_REAL_DICTATION=1 npm test` adds an opt-in test that installs tiny.en and transcribes a synthesised clip.

Dictation uses these third-party components:

- `sherpa-onnx-node` 2.0.1 and its per-platform `sherpa-onnx-<os>-<arch>` packages (Apache-2.0). These are prebuilt N-API addons that include ONNX Runtime (MIT).
- `unbzip2-stream` 1.4.3 (MIT), with `through` (MIT), `buffer` (MIT), `ieee754` (BSD-3-Clause) and `base64-js` (MIT).
- Speech models (downloaded, not bundled): OpenAI Whisper `tiny.en` and `base.en` weights (MIT). They were exported to int8 ONNX by the k2-fsa sherpa-onnx project and are published in its `asr-models` GitHub release.

`npm run verify:providers` starts real Claude and Codex calls using existing authentication and can consume provider usage. It is a separate opt-in check. `WORKSPACE_VERIFY_MODELS` accepts a JSON object with `claude` and `codex` model IDs; `WORKSPACE_VERIFY_PROVIDERS` selects a comma-separated subset. The provider fixture checks exact file edits, an append-only execution count, and unchanged session generations and provider process IDs across application quit/reopen. Prompts are sent once per new attempt. Model fields start blank, which inherits the installed CLI default; the tested models `claude-opus-4-6` and `gpt-6.1-sol` are offered as suggestions.

`npm run verify:remote-provider` is a separate opt-in check that launches one real Codex `gpt-6.1-sol` task through the authenticated browser gateway using existing host authentication. It can consume provider usage and is outside the ordinary test gates.
