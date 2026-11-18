# Agent Workspace 0.4.0: end-to-end UX repairs

The November 1 desktop audit identified 12 findings; the repaired build was completed on November 2. This release connects the existing capabilities into a usable daily workflow and fixes the observed state, history, keyboard and sizing defects. The changes were implemented and reviewed by the primary agent, without subagents or live model-generation calls.

## Findings and changes

| Finding | Change | Verification |
| --- | --- | --- |
| F01: no canvas connections | Source/recipient picker, connection handles, reviewed snapshot, explicit read-access consent, directional status labels and revocation. Optional recipient instructions require Insert and Enter. | `verify:ux`, `verify:accounts`, `ux-repairs.test.ts`, transcript authorization tests |
| F02: failed turn stays Working | Claude `StopFailure` reports an error; stale activity becomes Check terminal. Failed turns can branch. Explicit owner confirmation repairs old idle sessions without killing them. | Real tmux + fixture hooks in `ux-repairs.test.ts`; power and conversation tests |
| F03: missing final output | Final capture loads into the mounted terminal on exit. Explicit End saves the screen before destroying its pane. Late output/ack errors cannot re-enable or obscure an ended terminal. | `verify:ux`, `verify:lifecycle`, updated core capture regression, terminal fidelity checks |
| F04: focus escapes dialogs | Shared initial focus, background inertness, focus containment, Escape and return-focus behavior. Palette retains its own Escape behavior. | Keyboard traversal and dismissal in `verify:ux`; existing modal workflows |
| F05: clipped modal footer | Shared viewport sizing, scrollable content and reachable headers/footers; specialized modal sizes match the overlay inset. | Bounds checks and screenshots in `verify:ux` |
| F06: incomplete canvas lifecycle | Card menus, rename, keyboard move buttons, hide/archive, undo/restore, hidden ended sessions, consistent task titles, fixed viewport on item additions, wrapped note placement and separate toolbar space. | `verify:ux`, `verify:workflows`, `verify:lifecycle`; metadata revision tests |
| F07: competing work representations | Consistent default stage names; runtime state explained separately; attach an existing session to a task without launching another process. | PID/count preservation in `ux-repairs.test.ts`; UI attachment and board tests |
| F08: cramped editor / no keyboard save | Expand/restore editor, Command-S/Ctrl-S and Saved/Unsaved feedback. File-conflict checks retained. | Actual file readback in `verify:ux`; editor conflict/quit tests in `verify:workflows` |
| F09: infrastructure without onboarding | Phone setup steps and explicit folder selection; SSH prerequisite/check/browse guidance; Team join versus owner setup guidance. Server archive now includes the team service and guide. | Selected-folder desktop/browser checks, SSH fixture tests, team fixture tests; archive validation |
| F10: unknown provider/account readiness | Explicit installed-versus-authenticated-versus-model-ready distinction; owner-only CLI account report with a strict output allowlist; profile isolation limitations remain visible. | Fixture identity and rejected extra fields in `ux-repairs.test.ts`; profile UI checks. Installed real CLI command/JSON shape inspected read-only. |
| F11: low contrast and weak keyboard affordances | Stronger muted-text token; modal behavior; named connection controls; move alternatives and standard save shortcuts. | Source color check, visual inspection and keyboard UI checks. This is not a complete WCAG certification. |
| F12: scattered advanced actions | One Settings & connections entry, session More actions, consistent Connect agents naming, searchable account/voice/phone/SSH/team actions, direct worktree launch controls and a folder-location field. | `verify:ux`, account/board/worktree regressions |

## Important behavior

- A connection grants access to an immutable, reviewed snapshot. It does not run the recipient, synchronize future turns or submit a prompt.
- New context-read permission lasts 15 minutes. Adding read permission to an existing grant preserves its identity, expiry, other permissions and budgets. Revocation of a link blocks subsequent reads; already-read content cannot be recalled.
- A task's work stage and a process's runtime state are separate. Attaching a session does not start, stop or resend anything to its process.
- Canvas hiding and note archiving are reversible metadata changes. They do not delete project files or stop sessions.
- New worktree sessions retain their validated worktree root so file review follows the correct isolated copy when the session is reopened.
- Current provider hooks cannot retroactively observe an error from an older running CLI. Such sessions become visibly stale; the owner can inspect the terminal and explicitly mark it idle. New launches use the updated hooks.
- A final screen previously discarded by an older app cannot be recovered by this update. New natural exits and explicit End operations retain captures.

## Migration and safety

Schema 9 adds optional record fields and an error/stale activity state without rewriting existing session IDs, generations, backend sockets or PIDs. The normal online SQLite backup runs before an existing store upgrades. Note archive/restore and task attachment validate identity, revision and folder boundaries. New account and access-management methods stay on owner-only IPC; paired browsers and agents cannot use them.

The macOS fixture suite was repaired to avoid Linux-only `/proc`, `stat -c`, `/run/sshd`, and system-file assumptions. It no longer assumes Codex is absent from the developer's PATH. The disposable SSH server disables rate penalties only in its own test config so deliberate host-key rejection cases do not trigger unrelated connection resets. Production host-key checks remain strict.

SSH and standalone-server entrypoints now compare canonical filesystem paths. A real macOS regression was found where launching through `/var` or another symlink exited before starting the helper. Remote folder browsing also has a location field and a truncation notice, so a large directory listing cannot strand the user.

Team credential storage is now lazy and asynchronous: opening a local workspace or its task board does not touch Keychain. Checking storage is an explicit Team setup action; an existing saved team session restores asynchronously. Refresh writes are ordered with logout so late encryption cannot recreate a signed-out session file. The test-only store uses an ephemeral encryption key without accessing real system credentials.

Testing also exposed a comment ordering bug: comments created within the same millisecond were ordered by random IDs. The cache now retains creation order using the change sequence, without moving a comment when it is edited.

## Limits

No live generation, second-account sign-in, microphone recording, physical-phone pairing, external SSH host provisioning or production team identity-provider deployment was performed for this repair. Fixture providers are used in automated tests. Voice's microphone-refusal recovery path is exercised; recognition accuracy is not claimed from that check.

The app remains an unsigned local macOS build. Signing/notarization, an updater, Windows distribution and managed cloud hosting were not findings in this UX audit and are not added by this release.

Claude's failure event was verified against the [official hooks reference](https://code.claude.com/docs/en/hooks#stopfailure). Credential APIs were checked against the [Electron safeStorage reference](https://www.electronjs.org/docs/latest/api/safe-storage). Current test outcomes and packaged evidence belong in [release-evidence.md](release-evidence.md).
