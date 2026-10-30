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
  1. SSH projects (roadmap §2).
  2. Mac signing and notarization, auto-update, Windows client, Homebrew (§8).
  3. Multiple Claude accounts with conversation branching and transcript links (§3).
  4. Team features: members, comments, assignments (§9).

## What exists now

| Area | State |
| --- | --- |
| Folder-first launch | In-app folder browser, one click Claude/Codex/Shell, blank interactive launch, launch options, idempotent `terminal.open` |
| Sessions | tmux persistence, saved final screen on exit, Claude status hooks (working / needs you / done, with `activityAt` lease), notifications, resume, rename |
| Board | Live session board with lanes (`session.place`, `lane.*`) plus the original task board |
| Canvas | Sessions and notes as nodes, right-click to add, revisions |
| Agent control (§4) | `awctl` CLI over a Unix socket with owner-granted, expiring, per-session capabilities |
| AI suggestions (§5) | Opt-in commit message and session-name drafts through a locked-down CLI runner; Claude verified against `--help`, Codex built but unverified |
| Owner utilities | Screenshot paste, keep-awake, local English dictation (sherpa-onnx, model downloaded on demand) |
| Remote | Paired HTTPS browser gateway, phone layout, PWA; owner-only features are hidden and refused remotely |
| Data | Migration registry `src/core/migrations.ts`, schema **v5** (`roadmap_04_controller`), backups before upgrade |
| Policy | `src/shared/command-policy.ts` classifies every command as owner-only or remote, with a test enforcing it. Agent-control verbs are in `CONTROLLER_WRAPS` |

The roadmap reserved migration names. v4 became `board_lanes` and v5 `roadmap_04_controller`. When `roadmap_02_conversations`, `roadmap_03_execution_hosts` and `roadmap_05_team_metadata` land, each takes the next unused number.

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
- Last full run on the merged tree:

  | Check | Result |
  | --- | --- |
  | `npm test` | 79 pass, 2 opt-in skipped |
  | `smoke` | 8 |
  | `smoke:ui` | 9 |
  | `verify:agent-control` | 10 |
  | `verify:assist` | 6 |
  | `verify:board` | 10 |
  | `verify:workflows` | 15 |
  | `verify:lifecycle` | 6 |
  | `verify:terminal` | 7 |
  | `verify:image-paste` | 6 |
  | `verify:keep-awake` | 9 |
  | `verify:dictation` | 12 (real model) |
  | `verify:desktop` | 4 |
  | `verify:remote-desktop` | 7 |
  | `verify:mobile` | 15 |
- `verify:terminal` once timed out under back-to-back load and then passed 3 of 3 standalone.
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

## Next step: SSH projects (roadmap §2)

Follow §2 as written:
- system OpenSSH with `ssh -T` and framed stdio to a fixed, versioned helper entrypoint built from the standalone server;
- a host router so the remote core stays authoritative;
- no arbitrary `-o` options, agent forwarding or auto-provisioning;
- strict host-key handling;
- migration `roadmap_03_execution_hosts` at the next free schema number.

Split it into: read-only host probe, then shell lifecycle across disconnect/reconnect, then remote Files/Git, then providers and attachments. Test against a local disposable `sshd` with a throwaway key, without using model usage.
