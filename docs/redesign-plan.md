# Agent Workspace: full UI and UX redesign plan

Drafted 2026-11-17 against `codex/ux-repair` (v0.4.3). Rulebook: the `better-*` skills from
[jakubkrehel/skills](https://github.com/jakubkrehel/skills) (typography, layout, colors, UI
polish, writing, accessibility). Evidence comes from `src/renderer/*.css`, `App.tsx`,
`LaunchBar.tsx`, `SessionBoard.tsx` and the screenshots in `docs/screenshots/`.

Status: direction B (Native Mac) chosen. Phases 0–4 implemented on `redesign/native-mac`;
see §8.

---

## 1. Why it reads as "robotic" and "AI-made"

The font is not the problem: the app already renders SF Pro (`-apple-system` leads the stack at
`styles.css:52`). The robotic feel comes from how every layer is used. Specifically:

| # | Symptom | Evidence | Skill rule it breaks |
|---|---|---|---|
| 1 | **No type scale.** 141 rules at `12px`, 34 at `12.5px`, plus `13`, `13.5`, `14`, `15`, `16`, `18`, `19`, `22`, `26px`. Root is `13px`. Everything is the same small grey size, so nothing leads. | `grep font-size src/renderer/*.css` | Typography: small named scale, size+weight carry hierarchy |
| 2 | **Uppercase tracked eyebrows** ("FOLDERS", "SESSIONS", "READY IN STOREFRONT", "NEEDS YOU"). This is the single strongest generated-UI tell. | `App.tsx:2177`, sidebar headings | Typography: fewer sizes and weights; Writing: natural case |
| 3 | **Boxes inside boxes.** 88 `border: 1px` rules. Board lanes are bordered, cards inside are bordered, the canvas toolbar is a bordered box under a bordered header under a bordered title bar. | `board-sessions.png`, `light-canvas.png` | Layout: group with space first, lines last; UI: shadows for elevation, borders only for structure |
| 4 | **Spacing has no system.** 75 distinct padding values; gaps of 2, 4, 5, 6, 7, 8, 9, 10, 12px. | `grep padding/gap` | Layout: one spacing step per nesting level; between-group gap ≥ 2× within-group |
| 5 | **Radius has no system.** 14 different radii (4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 999, 50%…) and nested surfaces share the same radius. | `grep border-radius` | UI: outer radius = inner + padding |
| 6 | **The default "AI dev tool" palette.** Blue-black `#0b0d12` with a periwinkle accent `#8b9dff`. Ten-plus hues compete: three provider colours, four status colours, branch purple, accent. Shell green and Done green are the same meaning-slot. | `styles.css:3-50` | Colors: one neutral + one accent ramp; one colour, one meaning; status ≥15° from accent |
| 7 | **The three-card feature grid.** Icon tile + bold title + grey sentence, ×3, centred, under an eyebrow and a headline. The same launch buttons also sit in the header right above it. | `launchpad.png`, `App.tsx:2175-2222` | Layout: one primary action per view |
| 8 | **Explainer copy everywhere.** "Nothing is sent until you type. Sessions keep running…", "Every session in this folder is a card. Moving a card only files it…", "Arrange your agents and notes… a line never starts work automatically." Reassurance sentences narrating the system read like generated text. | `App.tsx:2220`, `SessionBoard.tsx:176`, `CanvasView.tsx` | Writing: delete every word that does no work; persistent info never lives in empty states |
| 9 | **Two to four rows of chrome before content.** Title bar (name + full temp path), then "Opens in" row with the folder again + branch + launch buttons, then (Canvas) a description row, a toolbar box and an undo row. ~116–270px of chrome. | `launchpad.png`, `light-canvas.png` | Layout: order by importance; keep controls in one stable zone |
| 10 | **Monospace as decoration.** Folder names, card subtitles ("alpha" on every card), tool chips (`tmux` `git` `claude`) are set in mono. Repeating the current folder on every card adds noise. | `board-sessions.png` | Typography: rarely more than needed; mono for code and identifiers only |
| 11 | **Flat, uniform text buttons.** "Move to…", "Resume", "New here", "Open terminal", "Connect", "Actions" all look alike and sit on every card at once. | `board-sessions.png`, `light-canvas.png` | Layout: secondary actions behind a menu after 3; Colors: fill exactly one action per view |
| 12 | **Motion and polish gaps.** One `prefers-reduced-motion` block for the whole app; no press feedback; no shared easing or durations. | `styles.css:3358` | UI: transitions with exact values, gated behind reduced motion |

---

## 2. Design principles for the new version

1. **The terminal is the product.** Chrome gets out of its way: one header row, everything else
   in the sidebar, an inspector, or the command bar.
2. **Quiet by default, colour only for meaning.** Greys carry 90% of the interface. Colour appears
   only for status that needs you (needs input, failed) and the one primary action.
3. **Group with space, not lines.** Borders survive only on inputs, dividers that space can't
   carry, and selected states.
4. **Say less.** Labels are nouns, buttons are verbs, help text appears where a decision is made,
   never as ambient narration.
5. **One way to do each thing.** Launch lives in one place per view. Card actions live in one menu.

---

## 3. Foundations (design tokens)

All tokens move into a new `src/renderer/tokens.css`, imported first. Components reference
semantic tokens only; primitives never appear in component CSS.

### 3.1 Typography

**Chosen direction: B, Native Mac** (decided 2026-11-17).

| Role | Face | Why |
|---|---|---|
| Interface | **SF Pro** via `system-ui, -apple-system` | The face every first-party Mac app uses; Chromium switches between the Text and Display cuts by size automatically. Falls back to Segoe UI / Roboto in the remote browser |
| Code, paths, terminal | **SF Mono** via `ui-monospace, "SF Mono", Menlo` | Same metrics family as SF Pro, so mixed lines sit on one baseline. Terminal font stays user-overridable |

The fonts don't change much from today. What changes is how they're used: the scale, the
weights and where mono appears.

**Scale** (follows the macOS text styles; rem-based with the root at 16px so browser zoom works):

| Token | macOS style | Size | Line-height | Weight | Used for |
|---|---|---|---|---|---|
| `--text-caption` | Subheadline | 0.6875rem / 11px | 1.35 | 400 | Timestamps, counts, kbd hints |
| `--text-small` | Callout | 0.75rem / 12px | 1.35 | 400 | Secondary metadata, helper text |
| `--text-body` | Body | 0.8125rem / 13px | 1.4 | 400 | Default UI text, list rows, buttons |
| `--text-headline` | Headline | 0.8125rem / 13px | 1.4 | 600 | Window title, card titles, list emphasis |
| `--text-heading` | Title 3 | 0.9375rem / 15px | 1.3 | 600 | Panel and dialog titles |
| `--text-title` | Title 1 | 1.375rem / 22px | 1.2 | 700 | Empty-state and first-run headline only |

Control heights follow AppKit: 22px small, 28px regular, 32px large. Sidebar rows 28px, list
rows 24px, unified toolbar 52px.

Rules: five sizes in daily use, never `12.5px`/`13.5px`. Emphasis is a weight step (400→500),
not a size change. No uppercase eyebrows; section headings in the sidebar become 12px/500
sentence-case in `--text-tertiary`. `tabular-nums` on counts, timers, durations, line numbers.
`text-wrap: balance` on headings, `pretty` on paragraphs. Inputs render at 16px on touch
viewports (remote/mobile).

### 3.2 Colour

Replace the blue-black + periwinkle system with **macOS system colours**:

- **Neutrals are the macOS window greys, with no blue tint.** Dark: window `#1e1e1e`, content
  `#252525`, raised `#2d2d2d`. Light: window `#f5f5f5`, content `#ffffff`, raised `#ffffff`
  with a shadow ring. Text uses solid equivalents of `labelColor` / `secondaryLabelColor`
  (measured to 4.5:1, never the native 25% tertiary, which fails).
- **The accent is the user's own macOS accent colour.** Electron
  `systemPreferences.getAccentColor()` sends it to the renderer at startup and on change; the
  remote browser falls back to system blue (`#007aff` light, `#0a84ff` dark). Text on an accent
  fill picks white or black by measured contrast, so Yellow and Graphite accents still pass.
  The accent marks focus rings, the selected item in focused lists, toggles, links and the one
  primary button per view.
- **Status uses the macOS system colours, only where the product shows it:** `attention`
  (needs input, systemOrange), `danger` (failed, destructive, systemRed), `running` (a small
  systemGreen dot, not a pill). Done and ended are neutral grey. Light-mode values are darkened
  where needed to pass 4.5:1 as text.
- **Sidebar** is translucent (`vibrancy: 'sidebar'`), with the selected row as a grey rounded
  rectangle, as in Finder.
- **Providers keep identity through their glyph,** not colour washes. Claude/Codex/Shell icons
  keep a single brand tint each, used on the 16px glyph only. Shell becomes neutral so it no
  longer collides with green "done".
- Semantic token names: `--bg-app`, `--bg-sidebar`, `--bg-surface`, `--bg-hover`,
  `--bg-selected`, `--border-subtle`, `--border-field`, `--text-primary`, `--text-secondary`,
  `--text-tertiary`, `--action-primary-bg`, `--action-primary-text`, `--accent`,
  `--status-attention`, `--status-danger`, `--provider-claude`, etc. Every pair re-measured for
  4.5:1 (text) and 3:1 (field borders, focus) in both themes before merge.
- One theme mechanism: keep `data-theme` and drop any parallel `prefers-color-scheme` colour
  blocks. Suppress transitions during theme switch.

### 3.3 Spacing

4px base, nine steps: `--space-1` 4 · `2` 8 · `3` 12 · `4` 16 · `5` 20 · `6` 24 · `8` 32 ·
`10` 40 · `12` 48. Within a group 8px, between groups 16–24px, between page sections 32px. Every
existing padding and gap is mapped onto these; the 75 one-off values go away.

### 3.4 Radius and elevation

- Three radii: `--radius-sm` 6px (inputs, buttons, chips), `--radius-md` 10px (cards, menus,
  popovers), `--radius-lg` 14px (dialogs, canvas nodes). Pills only for the status dot and
  counters. Nested surfaces follow outer = inner + padding.
- Elevation by layered shadow, not borders: `--shadow-border` (1px ring + soft lift) for cards
  and menus, `--shadow-overlay` for dialogs and the command palette. Dark mode uses a single white
  8% ring. `border: 1px solid transparent` under rings for forced-colours mode.

### 3.5 Motion

Shared tokens: `--ease-out: cubic-bezier(0.2, 0, 0, 1)`, `--dur-fast: 150ms`,
`--dur-base: 200ms`, `--dur-enter: 300ms`. Buttons press to `scale(0.96)` over 150ms (never when
disabled). Menus/popovers enter with opacity + 4px translate; exits shorter. Row hover and tab
switches are instant or ≤150ms on background-colour only. Everything that moves sits behind
`prefers-reduced-motion: no-preference`, with an opacity fallback. Hover styling behind
`@media (hover: hover)` for the phone remote. Never `transition: all`.

### 3.6 Icons

Keep `lucide-react` (one library). Standardise on 16px at `stroke-width 1.5` beside 13px text,
20px for empty states. Outline by default, filled for the active state. `currentColor` only.

---

## 4. Layout and information architecture

### 4.1 App shell

```
┌────────────┬──────────────────────────────────────────────┬──────────────┐
│ Sidebar    │ Header: folder ▾  branch  ·  [Terminals|Board|Canvas]  ⌘K  + New ▾ │
│            ├──────────────────────────────────────────────┤ Inspector    │
│ Folders    │                                              │ Files /      │
│ Sessions   │                Main view                     │ Changes /    │
│            │                                              │ Worktrees    │
│ ─────────  │                                              │ (collapsible)│
│ status     │                                              │              │
└────────────┴──────────────────────────────────────────────┴──────────────┘
```

- **One header row (44px)** replaces today's two. Left: folder name as a menu (switch folder, copy
  path, reveal in Finder) with the branch beside it as a small chip. The full temp path moves into
  that menu and a tooltip. Centre-left: view switcher as a segmented control. Right: search
  (`⌘K`) and a single **New** split button (primary ink fill): click = last-used provider, caret
  = Claude / Codex / Shell / launch options. This is the view's one primary action.
- **Sidebar** on macOS uses native vibrancy (`BrowserWindow` `vibrancy: 'sidebar'`) with a
  translucent background; in the browser build it falls back to `--bg-sidebar`. Section labels
  become sentence-case "Folders" / "Sessions". Session rows: provider glyph, name, one line of
  secondary text (state in words: "Needs input", "Working", "Idle 4m"), live dot only when
  running. "Needs you" sessions sort to the top with an amber dot and label, not a separate
  uppercase section.
- **Sidebar footer** shrinks to one row: connection status dot + "Local" and a settings gear. The
  `tmux` `git` `claude` `codex` chips move into Settings → Environment, shown only when something
  is missing.
- **Inspector** (right panel) keeps Files / Changes / Worktrees as tabs with an underline
  indicator, no filled tab pill.

### 4.2 Launch / empty folder

Replace the eyebrow + headline + three feature cards + disclaimer with a compact launcher:

- Title: the folder name at `--text-title`; under it, branch and change count in secondary text.
- A short vertical list of three rows (Claude, Codex, Shell): glyph, name, keyboard shortcut
  (`⌘1/2/3`) right-aligned, one-line status only when something is wrong ("Not installed:
  set up"). The rows are the launch targets; no duplicate buttons in the header for this view.
- "Recent in this folder": last 3 ended sessions with Resume, so the empty state points forward.
- Delete the disclaimer sentence. If "nothing is sent until you type" needs saying, it lives once
  in first-run onboarding.

### 4.3 Terminals / session view

- Terminal fills the main area edge to edge with 12px inner padding; no card frame around it.
- A slim session bar above the terminal (36px): provider glyph + session name (inline rename),
  status text, then right-aligned icon buttons: Connect agents, Interrupt, overflow menu (End,
  Branch, Agent control, Export). Destructive "End" lives in the menu with a confirmation that
  names the session.
- The bottom input bar (voice typing, paste image, "Press Enter to send") becomes a single row
  with icon buttons and tooltips; "Press Enter to send" becomes a faint kbd hint only while voice
  typing is active.
- Session tabs (when several are open) as a tab strip in the session bar, not separate cards.

### 4.4 Board

- Lanes lose their borders and backgrounds; the lane is a column title (name + count in
  tabular-nums) over a gutter. Cards get `--shadow-border` and a 10px radius.
- Card content: glyph + name; one line "Working · 2m" / "Needs input" (amber dot + label) /
  "Ended"; no folder repeated (the whole board is one folder). All card actions (Move to,
  Resume, New here, Open) move into a hover/focus-revealed overflow menu plus drag. Clicking the
  card opens the session.
- "Needs you" cards get a 2px amber inline-start bar, not a full amber outline and tinted fill.
- Remove the explainer sentence under "Board"; put the one fact that matters ("moving a card
  never stops the process") in the empty-lane hint and the help popover.
- Sessions / Tasks toggle becomes a segmented control beside the title.

### 4.5 Canvas

- Collapse description row, toolbar box and undo row into one floating toolbar, bottom centre:
  Add ▾ (terminal, note), Connect agents, Show ended toggle, Undo / Redo, zoom. Hidden & archived
  goes into the Add menu.
- Canvas nodes: 14px radius, shadow ring, title bar with glyph + name + status dot; Open, Connect
  and Actions collapse into a header overflow menu. Connection handles appear on hover/focus only.
- Lighter dot grid; minimap restyled to the neutral ramp, and the "React Flow" attribution placed
  where it does not compete.

### 4.6 Files and Changes

- File tree rows at 28px with 16px indent steps, chevrons, file-type glyphs in neutral. Path
  header becomes a breadcrumb.
- Changes: staged/unstaged as two grouped lists with counts, commit box pinned at the bottom with
  a single primary "Commit" button. Diff view uses the neutral ramp with muted add/remove tints.

### 4.7 Settings & connections

- One settings window/sheet with a left nav (General, Appearance, Voice, Accounts, Connections:
  SSH / Remote access / Team, Workspace data, Environment). Each page uses grouped "inset" lists
  (label left, control right) like macOS System Settings, instead of stacked bordered cards.
- Merge the five feature stylesheets (`profiles.css`, `ssh-hosts.css`, `remote-access.css`,
  `team.css`, `agent-control.css`) onto shared form, list and dialog primitives.

### 4.8 Dialogs, menus, command palette, toasts

- Shared primitives in `ui.tsx`: `Dialog`, `Menu`, `Popover`, `Tooltip`, `SegmentedControl`,
  `Button` (primary/secondary/ghost/danger, sm/md), `IconButton`, `Field`, `Toast`.
- Dialog titles name action + object ("End 'Second shell'?"); buttons are verb + object.
- Undo toasts for reversible actions (hide, archive, move) instead of confirmations.

### 4.9 Remote browser / phone

- Same tokens; bottom navigation with 44px targets; inputs at 16px; safe-area insets with
  `viewport-fit=cover`; hover styles only on hover-capable pointers.

---

## 5. Copy pass

Run `better-writing` across every user-facing string:

- Cut ambient explainers (`App.tsx:2220`, `SessionBoard.tsx:176`, Canvas description) and move any
  essential fact to where the decision happens.
- Sentence case everywhere; verb-first buttons; one term per concept (decide "session" vs
  "terminal", "end" vs "terminate", "folder" vs "project" and apply it everywhere).
- Status vocabulary: Working, Needs input, Idle, Ended, Failed.
- Errors say what failed and how to fix it, next to where it failed.

The `scripts/verify-*.mjs` and `smoke-ui.mjs` runners select by visible text and accessible names,
so every rename lands in the same change as its script update.

---

## 6. Execution order

Each phase is shippable and verified before the next. Screenshots for every phase go in
`docs/screenshots/redesign/` (light + dark, 1440 and 900 widths, phone).

| Phase | Scope | Done when |
|---|---|---|
| 0. Inventory | Contrast-measure current pairs; list every colour literal, font-size, radius, padding; capture baseline screenshots of every view and dialog | Baseline in `docs/screenshots/redesign/before/` |
| 1. Tokens | `tokens.css` (type, colour, space, radius, shadow, motion), bundle fonts, remap existing variables onto new semantic tokens so the app re-skins without layout changes | Typecheck + `verify:appearance` pass; all pairs measured in both themes |
| 2. Primitives | Button, IconButton, SegmentedControl, Menu, Dialog, Field, Tooltip, Toast in `ui.tsx`; replace ad-hoc buttons | `smoke:ui`, `verify:ux` pass |
| 3. Shell | One-row header, New split button, sidebar redesign + vibrancy, footer, inspector tabs | `verify:workflows`, `verify:lifecycle` pass; keyboard walk of the shell |
| 4. Views | Launcher, session view, Board, Canvas, Files/Changes | `verify:board`, `verify:transcript-connect`, `verify:dictation`, `verify:image-paste` pass |
| 5. Settings & panels | Settings window, SSH, remote, team, profiles, agent control on shared primitives; delete per-feature CSS | `verify:ssh`, `verify:remote-desktop`, `verify:team`, `verify:accounts`, `verify:agent-control` pass |
| 6. Copy + motion | Writing pass, motion tokens, reduced-motion audit | All verify scripts updated and passing |
| 7. Mobile + review | Remote/phone layout, 320px and 200% zoom, RTL smoke; full `better-interface` review of the finished UI | `verify:mobile`, `verify:mobile-webkit` pass; review has no HIGH findings |

`styles.css` (4,256 lines) is split along the way into `tokens.css`, `base.css`, `shell.css`
and one file per view, so old rules are deleted rather than overridden.

---

## 7. Decisions needed before Phase 1

1. **Visual direction:** decided, **B. Native Mac**.
   - **A. Workbench:** IBM Plex Sans + Plex Mono, warm graphite neutrals, ink
     primary button, one cobalt accent. Calm, technical, distinctly un-generic.
   - **B. Native Mac:** keep SF Pro + SF Mono, sidebar vibrancy, macOS system accent colour via
     Electron `systemPreferences.getAccentColor()`. Feels like a first-party Mac app; least
     custom.
   - **C. Editorial:** a serif (e.g. Newsreader) for view titles and empty states over a grotesk
     body (e.g. Hanken Grotesk), warmer paper tones. Most personality, least "tool".
2. **Density:** comfortable (13px body, 32px rows) as above, or compact (12px body, 28px rows).
3. **Default theme:** keep dark-first, or make System the default.
4. **Terminology:** decided in Phase 6. **Session** is what you open (agent or shell). **Folder** is
   where it runs. "Terminal" means only the pane itself. View names describe layout (Terminals, Board,
   Canvas).

---

## 8. Progress

### Phase 0: baseline (done)
- `scripts/capture-ui.mjs <dir>` captures launchpad, session, Board, Canvas and Settings in dark
  and light at 1440×900. Baseline: `docs/screenshots/redesign/before/`.

### Phase 1: tokens (done)
- `src/renderer/tokens.css`: macOS greys, system accent, SF type scale, spacing, control heights,
  radii, shadows and motion. Legacy variable names alias the new semantic tokens so the existing
  CSS re-skins without layout changes. The old token blocks in `styles.css` are deleted.
- `src/shared/accent-colors.ts` + `installSystemAccent` in `src/desktop/main.ts`: the macOS accent
  colour is injected as CSS at load and on change. Fill, on-fill text and text variants are derived
  to pass 4.5:1 for all eight macOS accents (`tests/accent-colors.test.ts`).
- Every text token measured at ≥ 4.5:1 and field borders ≥ 3:1 against every surface in both
  themes.
- All 204 literal font sizes mapped onto five tokens; weights onto 400/500/600/700; 94 literal radii
  onto three tokens; 25 old-palette `rgba()` literals onto `color-mix()` of tokens, so light mode
  no longer uses dark-mode tints.
- Uppercase tracked labels removed; negative tracking kept only on 22px titles; launchpad and
  pairing accent glows removed.
- Terminal, Monaco editor, window background and `theme-color` moved to the new greys and SF Mono.
- Screenshots: `docs/screenshots/redesign/phase-1/`.

Not done in Phase 1, by design: spacing values (moved per component in Phases 2–4), sidebar
vibrancy (Phase 3), the default theme (still Dark).

### Phase 2: primitives (done)
- Shared controls rebuilt in place in `styles.css` (the app styles by class, so no new React
  wrappers were needed): `.button` / `.primary` / `.ghost` / `.danger` / `.small` as macOS push
  buttons (28px, 24px small, shadow ring, no visible border), `.icon-button` 28px, launch buttons
  matched to them.
- Segmented control shared by the view switch and Board's Sessions/Tasks; inspector tabs use an
  accent underline.
- Menus (`.popover.menu`, lane, canvas, session "More actions") and the command palette highlight
  the active item in the accent fill, like macOS menus. Dialogs, palette and toasts use the overlay
  shadow, 12px/10px radii and no borders.
- Fields 28px with a focus ring from the accent; checkboxes and radios take the accent;
  inputs are 16px on touch screens.
- Motion: press scales to 0.96 (never when disabled), hover styles only on hover-capable pointers,
  dialogs/palette/toasts enter with a short scale-and-fade and fade only under reduced motion.
- New tokens: `--control-bg`, `--control-ring`, `--ghost-hover`, `--segment-*`, `--menu-bg`,
  `--focus-ring`; `--control-sm` is 24px.
- Screenshots (now including a menu and the palette): `docs/screenshots/redesign/phase-2/`.

Known: `verify:ux` failed once in five runs (passed on every re-run); hover rules outside the
shared controls are still unguarded and move under `@media (hover: hover)` as each view is
redone.

### Phase 3: shell (done)
- **One toolbar row (52px).** The second "Opens in" row is gone: launch controls (`.launch-bar`)
  now sit in the toolbar. The temp path is no longer printed; it is the folder title's tooltip and
  "Copy folder path" stays in the folder menu. "Opens in" only appears when it adds something
  (a subfolder or worktree). The git chip is a quiet grey tag. On phones the toolbar wraps and the
  launch buttons take their own row.
- **macOS window chrome** (desktop macOS only, `data-chrome="mac-inset"` from preload):
  `titleBarStyle: "hiddenInset"` with traffic lights at (20, 19), `vibrancy: "sidebar"`. The
  toolbar and sidebar head are drag regions; every control and every overlay (dialogs, palette,
  menus, toasts) opts out. The in-app Light/Dark/System choice is sent to `nativeTheme.themeSource`
  so the translucent material matches the page. The brand mark and name are hidden on the desktop
  (the traffic lights take that corner); the remote browser keeps them.
- **Sidebar as a macOS source list:** 28px folder rows, 36px session rows, grey selection with
  an accent icon, 11px sentence-case section labels, counts as plain tabular numbers, no footer
  border. The footer is one line (connection status + a settings gear); tool chips only appear when
  something is missing ("Not installed: codex").
- `scripts/capture-ui.mjs` draws the sidebar with its opaque fallback in page screenshots (they
  cannot include native materials) and also saves a real window screenshot on macOS when the
  terminal has Screen Recording permission.

Not verified: the real translucent sidebar on screen. This terminal lacks Screen Recording
permission and app access was declined, so only page screenshots exist. Check it by opening the
built app.

Checks: smoke, UX, board, workflows, lifecycle, mobile, transcript connect, agent control and
keep-awake pass. `verify:appearance` failed once in the batch and passed alone. `verify:accounts`
fails because "Launch options" is not in the toolbar while a session is open; it fails the same way
on the commit before the redesign started, so it predates this work. The Phase 4 **New** button,
always in the toolbar, removes the cause. Keyboard walk: every toolbar, sidebar and Board control is
reachable by Tab in visual order with a visible focus ring.

Moved to Phase 4: the single **New** split button (needs the launcher redesign, since the three
launch buttons double as the Launchpad's targets).

### Phase 4: views (done)
- **New button.** The toolbar always has a split button: one click opens the provider used last
  ("New Claude"), the caret opens a menu of Claude, Codex and Shell (arrow keys, Escape). The
  launch bar now shows in every view, so "Launch options" is reachable with a session open.
- **Launchpad.** The eyebrow, "Open an agent or a shell here" headline, three feature cards and
  the disclaimer are replaced by the folder name, one line ("Choose an agent or a shell. Nothing
  runs until you type.") and a 440px inset grouped list. Accessible names ("Open Shell here")
  are unchanged. "Recently ended" uses the same row style.
- **Session view.** The duplicate branch chip in the tab strip is gone (the toolbar has it).
  Session tabs use the accent underline. The session bar is 48px with an unboxed glyph.
  Status is a dot plus a word, with no pill. The voice bar is quieter.
- **Board.** The explainer sentence is gone. Its one useful fact moved into the empty-lane hint.
  Lanes are columns of space with a 600-weight title and a tabular count. Cards have a shadow ring.
  "Needs you" gets a leading attention bar. Ended cards are outlined only. Card actions are ghost
  buttons.
- **Canvas.** The toolbar floats over the canvas as one rounded bar. "Connect agents" is a normal
  button, so the toolbar's New button stays the only filled one. Nodes have 12px corners, an overlay
  shadow and ghost toolbar buttons. Zoom controls and the minimap match.
- **Files.** The inspector uses the window background. Tree and change rows are 28px with no mono.
  The folder header is plain text with a hidden-when-disabled up button. "New sessions open in the
  folder shown here" only appears inside a subfolder.
- Test updated: `verify-workflows.mjs` waits for the "Open Shell here" button instead of the
  removed headline.

Checks (batch of 14): smoke, UX, lifecycle, mobile, transcript connect, agent control,
keep-awake, dictation, image paste and context menu pass. Board, workflows and appearance failed in
the batch and pass alone; appearance's focus check has now failed in two batches, so treat it as
flaky under load. `verify:accounts` now gets past Launch options (the pre-existing failure). It then
fails its last isolation check: a Claude transcript appears in the fixture's default `~/.claude`,
under a project named after the app's own checkout rather than any session folder. So it comes
from a Claude process started in the app's working directory, not from a launched session. Cause
not yet found.

### Phase 5: settings and panels (done)
- **Settings sheet.** It is titled "Settings" (its accessible name is unchanged), and the intro paragraph is gone. Rows are grouped into
  titled inset lists, as in System Settings: General (Appearance, Keep awake), Input (Voice
  dictation, AI suggestions), Accounts (Claude profiles, Team), Connections (SSH hosts, Remote
  access) and Data (Workspace data). Each row has a coloured icon tile (white glyph, 3:1 or better), the
  current state on the right and a chevron. In light, white groups sit on a grey sheet.
- **Deviation from 4.7.** There is no left nav. Each entry opens its own sheet, which the command palette and
  the tests also open directly. With eight entries, a nav column would add a click without adding
  structure, so the grouped list does that job.
- **Appearance** is now a row with a segmented control (Light / Dark / System). It still uses real radio
  inputs, laid invisibly over each segment, in place of the three radio cards. **Keep awake** is a row with
  an AppKit-sized switch (`input[role=switch]`, styled globally). The off track uses
  `--switch-off`, which passes 3:1. In forced colours it falls back to the native control.
- **Panel chrome.** Titles no longer carry icons. The generic eyebrows ("This computer", "Team",
  "This session") are gone. Every close button is the same 28px icon button with a 16px ×.
  The Team sheet title changes from "Team members, comments and assignments" to "Team".
- **One stylesheet.** `profiles.css`, `ssh-hosts.css`, `remote-access.css`, `team.css` and
  `agent-control.css` (1,233 lines) are replaced by `panels.css`, organised by primitive:
  - **Sheet sizes.**
  - **Intro copy.**
  - **Sections:** separated by space, not rules.
  - **Disclosures.**
  - **Item cards:** raised surface plus a shadow ring. Pending items are outlined only.
  - **Status dots.**
  - **Notices:** a leading bar coloured by severity.
  - **Tags:** grey unless they report a state.
  - **Check rows.**
  - **Secrets and codes.**
- **Other boxes.** The setup guide, the voice and AI radio cards, the AI input preview and the readable
  transcript also lose their borders. A selected radio card gets a 2px accent ring.
- **Layout fixes.** "Check default account" no longer stretches across the card. A lone button in a sheet
  keeps its natural width.
- **Tests and captures.**
  - `verify-team.mjs` now expects the dialog name "Team".
  - `verify-appearance.mjs` now waits for focus to reach "Show folders and sessions", which moves on
    the next animation frame. Its immediate check failed about half the time, on Phase 4 too.
  - `capture-ui.mjs` also captures SSH, Remote access, Profiles, Team and Workspace data (08–12).

Checks, run one at a time:
- **Pass:** smoke, SSH, remote desktop, team, agent control, keep-awake, assist, UX and transcript connect.
- **Appearance** passed 3 of 3 after the wait fix.
- **Dictation** failed once because its leftover check reads the system clipboard, and that
  held text copied during the run. It passed on rerun.
- **`verify:accounts`** still fails only its final default-folder isolation check, as in Phase 4.
- **`npm test`:** 144 pass, 0 fail.

### Phase 6: copy and motion (done)
- **Terminology:** see decision 4. "End this terminal process" becomes "End this session". Resume opens a
  "new session", not a "new terminal".
- **Explainers:** 10 long paragraphs are rewritten shorter, with every fact kept. They are
  Agent control, the remote "no folders" empty state, Voice dictation (×2), Claude profiles,
  Connect agents, AI suggestions, the Team header, Remote access and the SSH setup guide. Security and
  privacy statements stay word-for-word in meaning.
- **Messages:**
  - "Staged changes changed…" (four places, two of them in core) now reads "The staged changes are
    different from…".
  - The terminal input-limit error now says what happened in plain words.
  - "unsent change(s)" now uses the correct singular or plural.
- **Casing:** canvas notes say "Agent note" and "Note", not all caps. The palette key reads "esc", as on
  macOS. Sentence case was already consistent, and no Title Case strings were left.
- **Status words kept.** "Ready", "Needs you", "Working", "Turn failed", "Check terminal" and "Unknown"
  stay as they are. They are plainer than the "Idle / Needs input" proposed in section 5.
- **Motion:**
  - Every transition and token-timed animation now uses `--ease-out`. There was a mix of `ease-out`,
    `ease` and the token.
  - The mobile drawer's hard-coded 0.2s now uses `--dur-base`.
  - Status dots pulse only for live work, slowed to 2s with an opacity-only keyframe. "Needs you" is a
    steady dot, since a board of blinking dots read as an alarm.
  - Reduced motion keeps its existing rule: no movement, and dialogs fade.
- **Tests updated:**
  - `verify-assist.mjs` and `tests/assist.test.ts` match the new staged-changes wording.
  - `verify-agent-control.mjs` expects "Agent note".

Checks: `npm test` gives 144 pass, 0 fail. In a sequential run of 24 UI suites, 21 pass. Smoke, desktop,
workflows, backend, lifecycle, board, agent control, transcript connect, appearance, SSH,
keep-awake, terminal, image paste, dictation, assist, remote desktop, mobile, mobile WebKit, team,
UX and context menu all pass. Three fail:
- **`verify:accounts`:** the same final default-folder isolation check as in Phases 4 and 5.
- **`verify:providers` and `verify:remote-provider`:** these are opt-in suites that run real Claude and Codex tasks on the
  host's accounts. They fail outside the UI. The provider runs didn't complete, and
  `remote-provider` calls `remote.enable` without the `sharedProjects` the core now requires.
  That script predates the redesign.

### Phase 7: mobile and review (done)
- **New capture script.** `scripts/capture-narrow.mjs <dir>` captures, in both themes, a 320px viewport (terminal,
  drawer, Settings), 200% zoom (terminal, Settings) and a right-to-left document (terminal, Board,
  Canvas, Settings). It writes `overflow.json`, listing anything wider than the viewport. Nothing
  scrolls sideways at any size. The phone screenshots from `verify:mobile` are in `phase-7/remote-*`.
- **Fixed:**
  - **Drawer was see-through (high).** In the Mac window, zooming to 200% switches to the narrow layout. The
    sidebar becomes a drawer over content, where the window's vibrancy can't show, so it was
    see-through. It now has an opaque fill, and the narrow toolbar clears the traffic lights.
  - **Session actions** on narrow screens were stretched into equal tiles, with End as a wide box.
    They are now 36px controls at the end of the row.
  - **Voice bar** at 320px wrapped to three lines. It now stays on one line with the hint ellipsised, and the
    keyboard shortcut is hidden on touch devices.
  - **Branch chip** cut off mid-word ("main · 4 chan"). It now ellipsises.
  - **Board Tasks view** still had its explainer paragraph, now removed. Its filled "New task" button is now a
    regular button, so the toolbar's New stays the only filled button in the view.
  - **Hover styles.** Eleven hover rules that only change colour are now inside `@media (hover: hover)`.
    Rules that also cover `:focus-visible` were split, so keyboard focus is unchanged.
- **Review, remaining (none high):**
  - *Low:* menu-item highlight rules combine `:hover` with `:focus-visible` and aren't gated. Menus close
    on tap, so touch never sees a stuck highlight.
  - *Low:* in right-to-left, directional arrows ("Move to →") don't flip. The app has no right-to-left locale.
  - *Low:* the toolbar keeps a separate Appearance button beside the Settings gear. It's kept
    because `verify:appearance` opens Settings through it.
  - *Medium:* phone session actions are 36px, below the 44px HIG size used by the bottom navigation.
  - *Known:* the narrow layout in the Mac window at 300% zoom wraps the toolbar to two rows.
    That's about 333 CSS px.

Checks: `npm test` gives 144 pass, 0 fail. In a sequential run of 21 UI suites, 18 pass, including `verify:mobile`
and `verify:mobile-webkit`. Two clipboard-based suites failed in the batch and pass alone:
- **`image-paste`.**
- **`dictation`:** a leftover-text dialog was still covering the page when it clicked.

`verify:accounts` fails only its final default-folder isolation check, as in Phases 4 to 6.
`verify:mobile` timed out once on its "Reconnecting · input paused" banner in an earlier
run and passed on rerun.
