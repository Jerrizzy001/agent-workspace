# Handoff for the next agent

Branch `claude/jolly-clarke-oo3rm5`. Read this first, then `README.md`, `docs/plans/feature-roadmap.md` (the authoritative design for everything still to build), and `docs/release-evidence.md` (what each feature's checks did and did not prove).

## Owner's direction

- Build the owner's own product, inspired by an existing app called nodeterm.
- **Clean-room rule:** do not read nodeterm's source, docs, site or assets, and do not copy its code, text, names or UI. nodeterm is BUSL-1.1. The owner wants to sell this product and post it publicly as their own work. Design only from this repository, the roadmap, and public documentation for the tools involved.
- **Owner preferences:**
  - Prefer permissive dependencies (MIT, Apache-2.0, BSD).
  - Never change global CLI authentication or configuration.
  - Default tests must not spend model usage.
- **Remaining work, in the owner's order:**
  1. ~~SSH projects (roadmap §2)~~ — done on Linux against a disposable sshd (see below and `docs/release-evidence.md`).
  2. Mac signing and notarization, auto-update, Windows client, Homebrew (§8).
  3. ~~Multiple Claude accounts with conversation branching and transcript links (§3)~~ — done on Linux with a fixture `claude` (see below and `docs/release-evidence.md`); never tried with a real account.
  4. ~~Team features: members, comments, assignments (§9)~~: built provider- and host-neutral, and verified on Linux against a local fake OIDC issuer (see below). The owner still has to choose hosting, identity provider and region before production use.

## What exists now

| Area | State |
| --- | --- |
| Folder-first launch | In-app folder browser, one click Claude/Codex/Shell, blank interactive launch, launch options, idempotent `terminal.open` |
| Sessions | tmux persistence, saved final screen on exit, Claude status hooks (working / needs you / done, with `activityAt` lease), notifications, resume, rename |
| Board | Live session board with lanes (`session.place`, `lane.*`) plus the original task board |
| Canvas | Sessions and notes as nodes, right-click to add, revisions |
| Agent control (§4) | `awctl` CLI over a Unix socket with owner-granted, expiring, per-session capabilities |
| AI suggestions (§5) | Opt-in commit message and session-name drafts through a locked-down CLI runner; Claude verified against `--help`, Codex built but unverified |
| SSH projects (§2) | **SSH hosts** panel; system `ssh -T` to a fixed helper (`bin/aw-ssh-helper` in the server archive, `src/server/stdio-host.ts`) speaking framed JSON (`src/shared/host-protocol.ts`); host router in the desktop utility (`src/core/host-router.ts`, transport in `src/core/ssh.ts`) with `ssh-<host>-<id>` IDs; remote shell/Claude/Codex, Files, Git, notes, canvas, tasks and lanes; auto-reconnect reattaches the same remote tmux session; image paste, agent control and AI suggestions refused for SSH sessions; SSH folders never shared with browsers |
| Claude profiles, branches, links (§3) | **Claude profiles** panel (`workspace:profiles`: list/create/setup/check/remove; private 0700 folders under `<data>/profiles/`, used as `CLAUDE_CONFIG_DIR` per tmux session only); profile picker in Launch options and a profile chip on each Claude session; **Branch** (`conversation.fork`, `--resume <id> --fork-session`, child ID from a per-session SessionStart hook in `@aw_session_start`); **Link context** (`transcript.preview/link/revoke/list`, versioned adapter `claude-code-jsonl/1` in `src/core/transcripts.ts`) and `awctl transcript read` (verb `transcript.read`) |
| Owner utilities | Screenshot paste, keep-awake, local English dictation (sherpa-onnx, model downloaded on demand) |
| Team (§9) | Self-hosted team service in `src/team/` (Node + its own SQLite and migration registry, any OIDC issuer via `openid-client`/`jose`, invite-only); **Team** panel; publish preview; comments; assignee; board card team state; owner-only `workspace:team`; session only in main-process `safeStorage`, failing closed; [docs/team-service.md](team-service.md) |
| Remote | Paired HTTPS browser gateway, phone layout, PWA; owner-only features are hidden and refused remotely |
| Data | Migration registry `src/core/migrations.ts`, schema **v8** (v7 `roadmap_02_conversations`, v8 `roadmap_05_team_metadata`), backups before upgrade |
| Policy | `src/shared/command-policy.ts` classifies every command as owner-only or remote, with a test enforcing it. Agent-control verbs are in `CONTROLLER_WRAPS`. The SSH helper accepts only the gateway's remote-allowed commands (`validateCommand`) plus `browse`, `register` and `hide`; `workspace:ssh` is owner-only IPC |

The roadmap reserved migration names. v4 became `board_lanes`, v5 `roadmap_04_controller`, v6 `roadmap_03_execution_hosts` v7 `roadmap_02_conversations` and v8 `roadmap_05_team_metadata`. `roadmap_05_team_metadata` takes the next unused number. §3 was built while another agent was adding the team migration in parallel: whichever merges second renumbers its entry (tests use `SCHEMA_VERSION` and migration names, never hard-coded numbers).

## Running checks in a Linux cloud container (how this was verified)

- Use Node 24: `export PATH=/opt/node24/bin:$PATH LANG=C.UTF-8 LC_ALL=C.UTF-8 WORKSPACE_TMUX=/usr/bin/tmux`. Download Node 24 from nodejs.org if it isn't present.
- The UTF-8 locale is required, or tmux prints `_` for non-ASCII characters.
- `npm ci` fails here because the network policy blocks the Electron header host (`www.electronjs.org`, `artifacts.electronjs.org`). Instead:
  1. `npm ci --ignore-scripts`
  2. `node node_modules/electron/install.js`
  3. In `node_modules/node-pty`, run `npx node-gyp rebuild --nodedir=<node install dir>`.
  4. `node scripts/prepare-native.mjs`

  node-pty and sherpa-onnx are N-API, so one build works in Node and Electron.
- Some tests hard-code `/opt/homebrew/bin/tmux`; symlink it to the system tmux.
- Electron runs as root under Xvfb through a wrapper: `#!/bin/sh` then `exec <repo>/node_modules/electron/dist/electron --no-sandbox <repo> "$@"`. Run `WORKSPACE_APP_EXECUTABLE=<wrapper> xvfb-run -a node scripts/<script>.mjs`.
- Browser scripts use the preinstalled Chromium: `WORKSPACE_BROWSER=/opt/pw-browsers/chromium`. `verify-assist` and `verify-remote-desktop` need it too.
- Last full run on the merged tree (before §3; the §3 branch re-ran the rows marked *):

  | Check | Result |
  | --- | --- |
  | `npm test` | see the merged-results note under "Roadmap §3 and §9 merge" |
  | `verify:team` | 8 (two Electron identities, fake OIDC issuer) |
  | `smoke` | 8 |
  | `smoke:ui` * | 9 |
  | `verify:agent-control` * | 10 |
  | `verify:accounts` * (new, §3) | 10 |
  | `verify:assist` | 6 |
  | `verify:board` * | 10 |
  | `verify:workflows` | 15 |
  | `verify:lifecycle` | 6 |
  | `verify:terminal` | 7 |
  | `verify:image-paste` | 6 |
  | `verify:keep-awake` | 9 |
  | `verify:dictation` | 12 (real model) |
  | `verify:desktop` | 4 |
  | `verify:remote-desktop` | 7 |
  | `verify:mobile` * | 15 |
  | `verify:ssh` * | 10 (disposable sshd; also once from the extracted archive with `npm ci`) |
  | `verify:server-release` | 3 |
- `verify:terminal` once timed out under back-to-back load and then passed 3 of 3 standalone.
- During the §3 work, one `npm test` run at the starting commit failed the two SSH tests (`host-router` timed out; the ssh probe test hit `EPIPE`) while the container was busy; the next two full runs passed them.
- SSH checks need OpenSSH: `apt-get install -y openssh-server openssh-client`. The fixtures run their own `sshd -D -f <temp config>` on a free loopback port with throwaway keys and their own known_hosts and client config (passed to the app as `WORKSPACE_SSH_CONFIG`, which adds `-F`); sshd needs its empty `/run/sshd` directory, which the fixture creates if missing. `tests/ssh*.test.ts` and `tests/host-router.test.ts` skip when sshd is absent. The container's `/usr/local/bin/node` is Node 22, so `verify:ssh`'s sshd sets `AW_NODE` with `SetEnv`; the tests' helper launcher runs this checkout's `src/server/stdio-host.ts` through tsx with Node 24.
- Only kill tmux servers your own fixtures created. A broad `/tmp/aw-*.sock` sweep is refused by the session's permission policy.
- Parallel sub-agents in git worktrees worked well. Symlink the main `node_modules` into each worktree, and reset each worktree to the branch tip first, because worktrees started from an older commit.

## Known gaps and cautions

- **Not checked on macOS:** packaging, signing, the Dock PATH discovery, the microphone permission, sherpa-onnx loading in a packaged app, `ELECTRON_RUN_AS_NODE` and the asar-unpacked `awctl`, Unix socket path length, and clipboard image reads.
- **Never run with a real model turn:** Claude's hooks firing; the assist flags under a hostile prompt. All of this used fixture CLIs.
- **Codex was never installed or run** here. Its resume, status and assist paths are unverified.
- **Exit status is best effort.** tmux sometimes never records a pane's exit status under load (reproduced in plain tmux). The saved screen is kept regardless.
- **Licence notices:** sherpa-onnx (Apache-2.0) and its bundled ONNX Runtime (MIT) need their notice texts in a packaged release. Dictation model checksums were computed locally, not taken from a published digest.
- **Real Claude request:** the AI-suggestions sub-agent made one accidental real Claude request (about $0.005). The container's CLI authenticated even with an empty HOME. Don't assume a cleared environment prevents real calls.
- **WebKit:** `verify:mobile-webkit` was ported to the new UI but never run, because WebKit isn't installed.
- **Leftover stash:** a stash named `dict-lock-tmp-aa90` is left on the repository (an old copy of the package files). It's safe to drop if the owner agrees.
- The repository has no LICENSE file yet. The owner must choose one before any public release.

## SSH projects (roadmap §2): state

Done on Linux, all four slices; details and exact results in `docs/release-evidence.md` ("Roadmap section 2"). Gaps to keep in mind:

- Never tried against a real remote machine, macOS (as desktop or host), Windows OpenSSH, ProxyJump hosts or non-root users. Only a fixture `claude` ran on the host.
- Not built: image attachments over SSH (pasting into an SSH session is refused with a message; the roadmap's bounded attachment frame is future work), browser sharing of SSH folders (off by design), app-managed known_hosts enrollment (the owner trusts keys with their own `ssh`).
- The helper must be installed by the owner from the server archive (`~/agent-workspace-server` by default, then `npm ci`); there is no auto-provisioning or helper update. A protocol bump needs a matching helper on every host.
- Reconnect is automatic after an unexpected loss (1, 2, 4, 8, 15 s); a host the owner left connected reconnects at app start. In-flight requests are reported as unknown and never resent.

## Claude profiles, branches and transcript links (roadmap §3): state

Done on Linux with a fixture `claude` (`scripts/claude-fixture.cjs`: honours `CLAUDE_CONFIG_DIR`, writes Claude-style JSONL, fires the hooks it is given). Details and results in `docs/release-evidence.md` ("Roadmap section 3"). Keep in mind:

- **Never run against a real Claude account.** Whether two real sign-ins stay separate (sign-in, token refresh, sign-out, simultaneous requests), what the macOS Keychain does, and whether real Claude names transcripts `<config>/projects/<folder>/<session id>.jsonl` and reports `transcript_path` there are all unverified. The adapter fails closed if any of that differs. The roadmap's opt-in real check (owner supplies two profiles, one tiny turn each, one branch, one fixture-only link) is still to do and needs the owner.
- The SessionStart hook keeps only the **first** report per session; after `/clear` the app still links (and resumes) the original conversation.
- Exports are capped (192 KiB of the newest text, 32 MiB source file) and stored in the database as immutable records; the 200 newest link records are kept (older revoked ones are pruned).
- Same computer only: profiles, branches and links are refused for SSH folders and have no gateway route. Codex fork is not built.

## Team members, comments and assignments (roadmap §9): state

Built and verified on Linux; details and exact results are in `docs/release-evidence.md` ("Roadmap section 9"), and setup is in `docs/team-service.md`. Gaps to keep in mind:

- **Not tried for real:**
  - a real identity provider; only `scripts/fake-oidc.mjs` over loopback HTTP was used;
  - a TLS deployment of the service;
  - the production secret stores (Keychain, DPAPI, Secret Service);
  - the real system browser (tests fetch the authorize URL);
  - restart persistence of the team session. The test-only Linux basic store uses an in-memory key, so it does not survive a restart.
- **Test switches**, honoured only with `WORKSPACE_TEST_DATA_DIR`:
  - `WORKSPACE_TEST_TEAM_BASIC_SECRET_STORE=1`: Electron's basic store, for headless Linux;
  - `WORKSPACE_TEST_TEAM_AUTOBROWSER=1` and `WORKSPACE_TEST_TEAM_LOGIN_HINT`: fetch the authorize URL instead of opening a browser;
  - `WORKSPACE_TEST_TEAM_SYNC_MS`: the sync interval.
- **Core boundary:** the core gained no command. Team state goes through `Core.team()` from main only, like `hostRecords`.
- **Service actions** are `TEAM_ACTIONS` in `src/shared/team-contracts.ts`; shared-task actions are named `sharedTask.*`.
- **Run it:** `npm run build` produces `dist/team/server.mjs` (run it with `npm run start:team -- --config <file>`) and `dist/team/service.mjs` (used by `verify:team`). It is not in the server archive yet.
- **Owner decisions still open:** hosting, identity provider, region, invitation and retention policy, backup schedule.
- **Not built:**
  - email invitations;
  - team-level invite and ownership transfer in the UI (the API supports team-level invites);
  - team deletion;
  - live push (the app polls every 15 s);
  - an audit log viewer in the app.

## Next step: Mac signing and notarization, auto-update, Windows client, Homebrew (roadmap §8)

Follow §8 as written. Before that, re-run the SSH checks on a Mac if one becomes available (`npm run verify:ssh` needs `sshd`; on macOS use a non-system sshd binary or Remote Login with a throwaway user).

## Roadmap §3 and §9 merge (merged results)

§3 (Claude profiles, branches, transcript links) kept migration v7 `roadmap_02_conversations`; §9 (team metadata) was renumbered to v8 `roadmap_05_team_metadata` at merge. On the merged tree, in the same Linux container:

- `npm test`: 116 pass, 2 opt-in skipped (118 tests), in two consecutive full runs.
- App checks:

  | Check | Result |
  | --- | --- |
  | `verify:accounts` | 10 |
  | `verify:team` | 8 |
  | `verify:ssh` | 10 |
  | `smoke` | 8 |
  | `smoke:ui` | 9 |
  | `verify:workflows` | 15 |
  | `verify:board` | 10 |
  | `verify:agent-control` | 10 |
  | `verify:assist` | 6 |
  | `verify:lifecycle` | 6 |
  | `verify:terminal` | 7 |
  | `verify:image-paste` | 6 |
  | `verify:keep-awake` | 9 |
  | `verify:dictation` | 14 |
  | `verify:desktop` | 4 |
  | `verify:remote-desktop` | 7 |
  | `verify:mobile` | 15 |
- **Fixed at merge:** the SSH tests intermittently failed with `write EPIPE`, and the same failure existed before §3/§9.
  - **Cause:** `src/core/ssh.ts` had no error listener on the ssh child's stdin. A frame written while ssh was exiting raised an unhandled `EPIPE`, which could crash the core in the app.
  - **Fix:** both spawn sites now handle stdin errors, and the existing close handler reports the lost connection.
  - **After the fix:** the SSH tests passed 5 of 5 standalone and in both full runs.
- **What's left on the roadmap:** §8 (Mac signing and notarization, auto-update, Windows client, Homebrew). It needs a Mac and owner-provided credentials and hosting; see the earlier sections for what can be prepared without them.
