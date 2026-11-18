import { useEffect, useState } from "react";
import {
  Ellipsis,
  GitFork,
  History,
  ImagePlus,
  Link2,
  LoaderCircle,
  Pencil,
  Play,
  Sparkles,
  Square,
  Zap,
} from "lucide-react";
import {
  AssistNameDialog,
  assistAvailable,
  loadAssistProvider,
  openAssistSettings,
} from "./assist";
import type { Project, Session } from "../shared/contracts";
import { TerminalView } from "./TerminalView";
import { providerName, sessionLocation, sessionState } from "./sessions";
import { ProviderGlyph, StatusBadge } from "./ui";
import { DictationToolbar } from "./DictationControl";
import { dictationAvailable, isDictationShortcut } from "./dictation";
import { AgentControlButton } from "./AgentControl";
import { profileLabel, profilesAvailable, useProfiles } from "./ProfilesPanel";
import { TranscriptLinksPanel } from "./TranscriptLinksPanel";
import { createId } from "./id";
import { endSession } from "./session-actions";

/** One session: identity, state and controls above its terminal. */
export function SessionView({
  session,
  project,
  title,
  onResume,
  onRestart,
  onEnded,
  report,
  sessions = [],
  titleOf,
  onOpen,
  handoffDraft,
  clearHandoff,
}: {
  session: Session;
  project?: Project;
  title: string;
  onResume: (session: Session) => void;
  onRestart: (session: Session) => void;
  onEnded: (session: Session) => void;
  report: (error: unknown) => void;
  /** All sessions, for branch lineage and link recipients (desktop). */
  sessions?: Session[];
  titleOf?: (session: Session) => string;
  /** Shows another session, for example a new branch. */
  onOpen?: (session: Session, draft?: string) => void;
  handoffDraft?: string;
  clearHandoff?: () => void;
}) {
  const profiles = useProfiles();
  const [linksOpen, setLinksOpen] = useState(false);
  const [branching, setBranching] = useState(false);
  // Branches and transcript links are desktop-owner features on this computer.
  const ownerLocal = profilesAvailable() && !session.hostId;
  const claudeIdle =
    session.status === "exited" ||
    (session.status === "running" &&
      !!session.activityTracking &&
      (session.activity === "done" ||
        session.activity === "error" ||
        !session.activity));
  const canBranch =
    ownerLocal &&
    session.provider === "claude" &&
    !!session.conversationId &&
    !session.profileSetup;
  const branch = async () => {
    if (branching) return;
    setBranching(true);
    try {
      const result = await window.workspace.invoke<{ session: Session }>(
        "conversation.fork",
        {
          sessionId: session.id,
          generation: session.generation,
          idempotencyKey: createId(),
        },
      );
      onOpen?.(result.session);
    } catch (error) {
      report(error);
    } finally {
      setBranching(false);
    }
  };
  const parent = session.forkedFrom
    ? sessions.find((s) => s.id === session.forkedFrom!.sessionId)
    : undefined;
  const profileName = profileLabel(session.profileId, profiles);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [handoffPaste, setHandoffPaste] = useState<{
    request: number;
    text: string;
  }>();
  const [imagePasteRequest, setImagePasteRequest] = useState(0);
  const [dictationToggle, setDictationToggle] = useState(0);
  // The shortcut also works while focus is outside the terminal (a focused
  // terminal handles it itself).
  useEffect(() => {
    if (!dictationAvailable() || session.status !== "running") return;
    const onKey = (event: KeyboardEvent) => {
      if (!isDictationShortcut(event) || event.repeat || event.defaultPrevented)
        return;
      const target = event.target as Element | null;
      if (
        target?.closest?.(
          '.xterm, input, textarea, [contenteditable], [role="dialog"], [inert]',
        )
      )
        return;
      event.preventDefault();
      setDictationToggle((value) => value + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session.status]);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const startRename = () => {
    setDraft(session.title || title);
    setRenaming(true);
  };
  const rename = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await window.workspace.invoke("session.rename", {
        ...identity,
        title: draft,
        titleRevision: session.titleRevision ?? 0,
      });
      setRenaming(false);
    } catch (error) {
      report(error);
    } finally {
      setSaving(false);
    }
  };
  const [naming, setNaming] = useState(false);
  const suggestName = async () => {
    setRenaming(false);
    const provider = await loadAssistProvider().catch(() => "");
    if (provider) setNaming(true);
    else
      openAssistSettings(
        "AI suggestions are off. Choose a provider to suggest session names; nothing is sent until you preview and click Generate.",
      );
  };
  const state = sessionState(session);
  const identity = {
    sessionId: session.id,
    generation: session.generation,
  };
  const name = providerName(session.provider);
  const end = (viewer: string | null) => endSession(session, viewer);
  // A CLI that failed at startup has nothing to resume; offer a fresh start instead.
  const resumable =
    session.status === "exited" &&
    !session.exitCode &&
    ["claude", "codex"].includes(session.provider) &&
    !!session.conversationId;
  return (
    <section
      className={"session-view tone-" + state.tone}
      aria-label={`${name} session`}
    >
      <header className="session-bar">
        <div className="session-identity">
          <ProviderGlyph provider={session.provider} size={16} />
          <div>
            {renaming ? (
              <span className="session-rename-row">
                <input
                  className="session-rename"
                  aria-label="Session name"
                  autoFocus
                  maxLength={80}
                  value={draft}
                  disabled={saving}
                  placeholder={name}
                  onChange={(event) => setDraft(event.target.value)}
                  onFocus={(event) => event.target.select()}
                  onBlur={() => !saving && setRenaming(false)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void rename();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setRenaming(false);
                    }
                  }}
                />
                {assistAvailable() ? (
                  <button
                    className="button ghost small"
                    title="Suggest a name with AI from context you choose"
                    // Keep focus in the field until the click opens the dialog.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void suggestName()}
                  >
                    <Sparkles size={12} />
                    Suggest name
                  </button>
                ) : null}
              </span>
            ) : (
              <strong>
                <span
                  className="session-title"
                  title="Double-click to rename"
                  onDoubleClick={startRename}
                >
                  {title}
                </span>
                <button
                  className="icon-button session-rename-button"
                  aria-label="Rename session"
                  title="Rename session (empty restores the default name)"
                  onClick={startRename}
                >
                  <Pencil size={12} />
                </button>
                <StatusBadge session={session} />
              </strong>
            )}
            <span className="session-meta" title={session.cwd}>
              <code>
                {sessionLocation(session, project) === "/"
                  ? project?.name || session.cwd
                  : (project ? project.name + "/" : "") +
                    sessionLocation(session, project)}
              </code>
              {session.model ? <span>· {session.model}</span> : null}
              {session.resumedFrom ? <span>· resumed</span> : null}
              {session.provider === "claude" && ownerLocal ? (
                <span
                  className="profile-chip"
                  title={
                    profileName
                      ? `Claude profile: ${profileName}`
                      : "Your usual Claude sign-in"
                  }
                >
                  {session.profileSetup ? "Sign-in · " : ""}
                  {profileName ?? "Default"}
                </span>
              ) : null}
              {session.forkedFrom ? (
                <span
                  className={
                    "profile-chip lineage-chip" +
                    (session.conversationState === "unknown" ? " unknown" : "")
                  }
                  title={
                    `Branch of ${parent && titleOf ? titleOf(parent) : "an earlier session"}. ` +
                    (session.conversationState === "unknown"
                      ? "Claude did not report this branch's conversation, so it is unknown. It cannot be resumed or branched."
                      : session.conversationState === "pending"
                        ? "Waiting for Claude to report this branch's conversation."
                        : "A separate conversation copied from the original; the original is unchanged.")
                  }
                >
                  <GitFork size={10} aria-hidden="true" />
                  Branch
                  {session.conversationState === "unknown"
                    ? " · unknown"
                    : session.conversationState === "pending"
                      ? " · …"
                      : ""}
                </span>
              ) : null}
            </span>
          </div>
        </div>
        <div className="session-actions">
          {ownerLocal && (canBranch || session.status === "running") ? (
            <details className="session-more">
              <summary title="More actions">
                <Ellipsis size={15} aria-hidden="true" />
                <span className="action-label">More actions</span>
              </summary>
              <div className="session-more-menu">
                {ownerLocal &&
                session.activityTracking &&
                (session.activity === "running" ||
                  session.activity === "stale") ? (
                  <button
                    className="button ghost small"
                    onClick={() => {
                      if (
                        confirm(
                          `Is ${name} back at its prompt and no longer working? Only confirm after inspecting the terminal. This marks the turn idle; it does not interrupt a running request.`,
                        )
                      )
                        void window.workspace
                          .invoke("session.confirmIdle", {
                            sessionId: session.id,
                            generation: session.generation,
                          })
                          .catch(report);
                    }}
                  >
                    Mark turn idle…
                  </button>
                ) : null}
                {canBranch ? (
                  <button
                    className="button ghost small"
                    disabled={!claudeIdle || branching}
                    title={
                      claudeIdle
                        ? "Branch: a new session continuing a copy of this conversation (same profile and folder). This one is not changed."
                        : "Branch when Claude has finished its turn"
                    }
                    onClick={() => void branch()}
                  >
                    {branching ? (
                      <LoaderCircle size={13} className="spin" />
                    ) : (
                      <GitFork size={13} />
                    )}
                    Branch
                  </button>
                ) : null}
                {!session.hostId ? (
                  <AgentControlButton session={session} report={report} />
                ) : null}
              </div>
            </details>
          ) : null}
          {ownerLocal && titleOf ? (
            <button
              className="button ghost small"
              title="Share a reviewed copy of a Claude conversation with another session, or revoke links"
              onClick={() => setLinksOpen(true)}
            >
              <Link2 size={13} />
              <span className="action-label">Connect agents</span>
            </button>
          ) : null}
          {session.status === "running" ? (
            <>
              {/* Pasted images stay on this computer. */}
              {window.workspace.clipboardImage && !session.hostId ? (
                <button
                  className="button ghost small"
                  title="Save the clipboard image privately and type its path (no Enter)"
                  disabled={!viewerId}
                  onClick={() => setImagePasteRequest((value) => value + 1)}
                >
                  <ImagePlus size={13} />
                  <span className="action-label">Paste image</span>
                </button>
              ) : null}
              <button
                className="button ghost small"
                title="Send Ctrl+C to the running program"
                disabled={!viewerId}
                onClick={() =>
                  void window.workspace
                    .invoke("session.input", {
                      ...identity,
                      viewerId,
                      data: "\u0003",
                    })
                    .catch(report)
                }
              >
                <Zap size={13} />
                <span className="action-label">Interrupt</span>
              </button>
              <button
                className="button danger small"
                title="End this session"
                onClick={() => {
                  if (
                    confirm(
                      `End this ${name} session? Its process stops and its final screen is saved. The folder and files are unchanged.`,
                    )
                  ) {
                    onEnded(session);
                    void end(viewerId).catch(report);
                  }
                }}
              >
                <Square size={11} />
                <span className="action-label">End</span>
              </button>
            </>
          ) : null}
          {session.status === "exited" ? (
            <>
              {resumable ? (
                <button
                  className="button small"
                  onClick={() => onResume(session)}
                  title={
                    session.provider === "claude"
                      ? "Continue this Claude conversation in a new session"
                      : "Open Codex's own list of earlier conversations here"
                  }
                >
                  <History size={13} />
                  {session.provider === "claude"
                    ? "Resume conversation"
                    : "Resume…"}
                </button>
              ) : null}
              <button
                className="button primary small"
                onClick={() => onRestart(session)}
              >
                <Play size={12} />
                New {name} here
              </button>
            </>
          ) : null}
        </div>
      </header>
      {session.activity === "error" ? (
        <span role="status" className="session-recovery">
          Turn failed. Read the error below, then retry or use /model to choose
          an available model. Billing is unchanged.
        </span>
      ) : null}
      {session.status === "exited" ? (
        <div className="session-ended" role="status">
          {session.exitCode && session.exitCode !== 0
            ? `${name} exited with status ${session.exitCode}.`
            : `This ${name} session has ended.`}{" "}
          {session.transcript
            ? "Its last screen is below — check it for an error message (for example a sign-in or model problem)."
            : "No final screen was saved for it."}
        </div>
      ) : null}
      {handoffDraft ? (
        <section
          className="handoff-draft"
          aria-label="Shared context instructions"
        >
          <strong>Ready to read the shared snapshot</strong>
          <p>
            Insert these instructions into this session. Nothing is submitted
            until you press Enter.
          </p>
          <pre>{handoffDraft}</pre>
          <button
            className="button primary small"
            disabled={!viewerId || session.status !== "running"}
            onClick={() =>
              setHandoffPaste((p) => ({
                request: (p?.request ?? 0) + 1,
                text: handoffDraft,
              }))
            }
          >
            Insert instructions
          </button>
          <button className="button small" onClick={clearHandoff}>
            Dismiss
          </button>
        </section>
      ) : null}
      {linksOpen ? (
        <TranscriptLinksPanel
          session={session}
          sessions={sessions}
          titleOf={titleOf ?? (() => title)}
          onClose={() => setLinksOpen(false)}
          onOpenSession={onOpen}
        />
      ) : null}
      {naming ? (
        <AssistNameDialog
          session={session}
          onClose={() => setNaming(false)}
          report={report}
        />
      ) : null}
      <div className="session-terminal">
        <TerminalView
          key={session.id}
          session={session}
          label={title}
          onViewer={setViewerId}
          endedNotice={false}
          imagePasteRequest={imagePasteRequest}
          handoffPaste={handoffPaste}
          onHandoffInserted={clearHandoff}
          dictationToggle={dictationToggle}
        />
      </div>
      {dictationAvailable() && session.status === "running" ? (
        <DictationToolbar
          viewerId={viewerId}
          onToggle={() => setDictationToggle((value) => value + 1)}
        />
      ) : null}
    </section>
  );
}
