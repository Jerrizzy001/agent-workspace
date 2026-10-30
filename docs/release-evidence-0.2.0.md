# Agent Workspace 0.2.0 verification evidence

> The phone screenshots and `mobile-verification.json` under `screenshots/remote/` were regenerated for 0.3.0. The 0.2.0 versions described here are in Git history at commit `daa4e45`.

Date: 2026-10-30. Distribution: unsigned internal alpha. Desktop target: macOS arm64. Standalone host targets exercised: macOS arm64 and Linux aarch64.

## Artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `release/Agent Workspace-0.2.0-arm64-mac.zip` | 145,579,784 | `850bcbad5e13d3f06b84adfdeb37feee4f7f4ad1551b92b6c925c9fed9de9f05` |
| `release/agent-workspace-server-0.2.0.tar.gz` | 3,683,484 | `de575598bd0ea1c5d7a42f20b177cbf168225c351f2f2b8bab340b7b8585457e` |
| Packaged `app.asar` | 163,540,975 | `e5959189a3a6b550f9e1721d34c3e58df60ffe8d9e02902f1047d89ae7d26397` |

The application was copied outside the checkout with `ditto` to a disposable temporary directory. Its `app.asar` hash matched the release copy. The copied runtime reported application version 0.2.0, `app.isPackaged === true`, Electron 45.1.0, Node.js 24.22.1 and arm64. Electron-builder rebuilt node-pty 1.1.0 for the packaged Electron runtime. Signing is explicitly disabled; the default Electron application icon remains.

These final artifacts include the note snapshot/remount fix. The final copied application passed smoke, native lifecycle, remote desktop recovery and live remote Codex checks. The final standalone archive passed a fresh independent `npm ci` and browser/native-PTY smoke. The final browser bundle passed the expanded mobile note regression. Exact final results and hashes are in [release-verification.json](screenshots/remote/release-verification.json). The retained 0.1.1 rollback zip has SHA-256 `9fd673950ba33e3f343f60ab6576279210e449fa9df0a5e9b3c281b7ca9946c8`.

## Behavior and architecture

The desktop gateway reuses its existing utility core, SQLite database, registered projects and tmux sessions. It does not create a second core. The gateway begins off on every application launch. Management IPC accepts only the active desktop window's main frame. Pairing is revealed only through that local interface; TLS files are chosen through native file pickers. The desktop panel lists the projects shared when access was enabled. Adding a project requires stopping and enabling access again to share it.

A paired browser has host-account workspace control through a named-command protocol. The gateway enforces owner cookie authentication, exact Host/Origin checks, a fixed project allowlist, command fields, session generations, per-connection viewer identities, message and queue limits, and bounded terminal output. Browser cookies are HttpOnly, SameSite=Strict and Secure over HTTPS, expire after 12 hours, and are separate for independent gateways on one host name. Revocation closes active connections, invalidates cookies and rotates the pairing code. Pairing codes are kept in an owner-only local file and are absent from HTTP routes, URLs and logs.

Non-loopback listeners require TLS. Private-network HTTPS and an HTTPS reverse proxy are documented; no tunnel, DNS record, public listener or external service is configured automatically. The browser client disables input during disconnection, clears unsent buffers, never replays uncertain input and reattaches existing sessions after reconnection. Touch controls use xterm's bracketed-paste and application-cursor modes.

The standalone server archive contains a bundled Node entrypoint, the same browser assets and PWA files, a minimal package manifest and lock, and a native-helper permission repair. Its dependencies are installed for the destination host's Node runtime; it has no Electron dependencies or Electron rebuild hooks.

## Verification

All fixture checks use disposable repositories, isolated data directories and exact fixture cleanup. Core ownership, terminal and desktop UI checks are serialized when they share the desktop/native runtime.

- TypeScript typecheck passed. All 29 tests passed, including the original 16 regressions and two final note snapshot tests. Gateway tests exercise real HTTP/HTTPS and WebSocket connections, unauthorized clients, project and viewer isolation, scoped snapshots, origin and static-path rejection, secure cookies, independent gateway cookies, revocation/login races, session expiry during authorization, bounded queued mutations and RPC flooding.
- The original desktop, smoke, visible UI, workflows, lifecycle and terminal suites passed after the remote changes. The lifecycle fixture now waits for a completed reconnect before typing. It separately verifies no-blur note autosave, then a cancelled native close retaining the exact draft, a user refocus and append without replacing content, and exact persistence after reopening. It does not require the operating system to preserve DOM focus through native close cancellation. The board fixture waits for the async status move before dragging. The forced-resync fixture waits for an emitted marker before blocking the renderer, so its command has actually reached the shell despite input batching.
- The desktop remote fixture verifies default-off state, insecure network rejection and foreign-window management rejection; a phone-sized Chrome browser pairs using the desktop's bundled assets; the authenticated remote protocol sees the same desktop session ID, generation, shell PID and output; a real utility-process crash emits reconnect/recovery events; revoke closes active sockets, clears private browser UI and rotates pairing; stopping the gateway leaves the desktop shell alive.
- Canvas notes keep a controlled local draft independent of incoming snapshots, serialize saves and fence older snapshots using acknowledged metadata. App snapshot delivery retains newer versions of notes still present in the incoming project scope, while accepting removals and other incoming fields. The regression delays save acknowledgement by 600ms, continues typing after a cancelled unload, injects stale event and reload snapshots, remounts the canvas, verifies removed notes stay removed, then checks exact UI/core content, immediate sign-out flush and browser restart. The native fixture also verifies continued typing and exact note persistence after actual application quit/reopen.
- Chrome 156.0.8078.79 passed all 14 browser workflow groups at touch phone viewports and desktop width: pairing, task/shell creation, preserved provider model fields, terminal input, bracketed multiline paste, normal/application cursor modes, note flush, files/board/canvas, portrait/landscape/keyboard-height resizing, actual offline input rejection, full browser restart with unchanged PID, two-client streams and resync, scoped worktree file save/diff, static-only PWA cache and dirty sign-out cancellation. The final 10,000-line stream produced one real resync, zero transport disconnections and 22 distinct final rows (9978–9999) matching tmux. All seven refreshed Chrome screenshots were visually inspected.
- WebKit 27.2 passed four groups over fixture HTTPS/WSS: Secure/HttpOnly/SameSite pairing cookies under CSP, touch task/shell creation and real file-producing input, reload preserving session/generation with responsive landscape, and sign-out clearing private UI. JSON evidence and inspected screenshots are under `docs/screenshots/remote/`.
- A fresh standalone archive was extracted outside the source checkout and installed with `npm ci`. Its own native PTY, browser pairing, real shell input/capture and PWA manifest worked without the checkout's dependencies. This caught and fixed the executable permission on node-pty's published macOS spawn helper.
- The standalone archive also ran inside an isolated, unprivileged Linux aarch64 container using the official image `node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`, Node.js v24.22.2 and tmux 3.3a. A disposable, self-signed HTTPS listener was published only to the Mac's loopback interface. A phone-sized Chrome context with fixture-only certificate trust paired, launched a real Linux shell and edited a file. Terminating and restarting only the host process preserved the exact tmux session ID, generation and pane PID; the browser re-paired and successfully sent further input. The fixture container and its image tag were removed.

The browser client is a responsive web app with installable PWA metadata and reconnect/offline status while the app is open. Only static assets are cached; HTML and API responses are not cached. A fresh offline launch is not supported. It is not a native iOS or Android application. WebKit/Chromium checks use desktop browser engines and phone viewport/touch emulation. No physical phone, mobile soft keyboard, public Internet route, external tunnel installation, Intel Mac or Linux x86_64 installation is claimed. Linux provider CLIs were not tested or given host credentials.

## Live remote provider evidence

The final copied packaged application launched exactly one Codex `gpt-6.1-sol` task using the host's existing authentication and codex-cli 0.166.0 at 2026-10-30 17:42 UTC. A paired phone-sized Chrome browser invoked the gateway, which launched the attempt through the desktop's existing core into a disposable managed worktree. The model created the exact requested newline-terminated proof file and appended exactly one execution line; the original repository remained unchanged. Closing and reopening the browser preserved the attempt ID, session ID, generation 1 and tmux pane PID 39194, with the execution count still one after reconnection. The fixture then terminated its session and removed its exact tmux socket. The durable result is [provider-verification.json](screenshots/remote/provider-verification.json).

## Prior provider evidence

The 0.1.1 live Claude and Codex file-edit and process-continuity proof is preserved in [the previous release evidence](release-evidence-0.1.1.md). Those checks used the same core provider-launch path and existing local authentication. They do not establish remote provider execution by themselves. The remote provider check is a separate opt-in command that can consume model usage.

## Reproduction

`npm run package` produces the unsigned macOS app and zip. `npm run package:server` produces the standalone server archive. `npm run verify:remote-desktop`, `npm run verify:mobile`, `npm run verify:server-release` and `npm run verify:linux-server` exercise the new paths. Docker checks honor the current Docker context or `WORKSPACE_DOCKER_HOST`; browser checks use installed Chrome unless a browser channel is supplied. `WORKSPACE_APP_EXECUTABLE` selects a copied packaged app for desktop fixtures. Run desktop UI checks serially.

The package remains an alpha with no signing, notarization, updater, collaboration roles, provider-specific structured approvals, usage accounting, reboot continuity or performance-budget claim. Live processes continue in tmux across view disconnects and host-process restarts; a reboot ends those processes. Vite reports large locally bundled Monaco chunks. Project shell access retains the host account's normal permissions.
