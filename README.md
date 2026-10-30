# Agent Workspace

An independently authored macOS desktop alpha for supervising local coding agents. Tasks, a board, a spatial canvas, terminals, notes, worktrees, and file review share a local core.

## Run

Requires macOS, Node.js 24+, Git, and tmux (`brew install tmux`). Claude and Codex commands use your existing installed CLI authentication. The app never installs providers or changes their configuration.

```sh
npm ci
npm run dev
```

`npm run build` creates the renderer and Electron entrypoints. `npm run typecheck` checks TypeScript. `npm test` runs the integration tests. `npm run package` creates an unsigned internal macOS application and zip in `release/`. Open the application in `release/mac-arm64/Agent Workspace.app` on Apple silicon. Build on the target architecture.

## Persistence and recovery

The Electron renderer is sandboxed and has no Node integration. A narrow preload forwards named workspace commands to a separate utility process. Metadata is kept in SQLite under Electron's application data directory. Terminal processes live in tmux on a private application socket: closing a view detaches it, and explicitly quitting the app stops its core without terminating tmux sessions. Reopening reconciles those sessions. A reboot ends live processes; history remains.

The app permits a single desktop instance. If the core crashes, the desktop makes up to three reconnection attempts. An interrupted command can have an unknown outcome; inspect state before retrying a mutation.

## Alpha scope

Local execution only. Terminal output can contain sensitive information and is visible to the local user. Provider terminals do not imply structured approval handling, conversation resume, usage accounting, remote access, or collaboration. Agent execution uses the same permissions as the desktop user. Terminate a session deliberately from the interface when it should stop.

The internal build is unsigned and has no updater. Packaging and runtime test evidence belongs in `docs/release-evidence.md`.
