import { useEffect, useState } from "react";
import { History, ImagePlus, Pencil, Play, Sparkles, Square, Zap } from "lucide-react";
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
import { DictationButton } from "./DictationControl";
import { dictationAvailable, isDictationShortcut } from "./dictation";
import { AgentControlButton } from "./AgentControl";

/** One session: identity, state and controls above its terminal. */
export function SessionView({
  session,
  project,
  title,
  onResume,
  onRestart,
  onEnded,
  report,
}: {
  session: Session;
  project?: Project;
  title: string;
  onResume: (session: Session) => void;
  onRestart: (session: Session) => void;
  onEnded: (session: Session) => void;
  report: (error: unknown) => void;
}) {
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [imagePasteRequest, setImagePasteRequest] = useState(0);
  const [dictationToggle, setDictationToggle] = useState(0);
  // The shortcut also works while focus is outside the terminal (a focused
  // terminal handles it itself).
  useEffect(() => {
    if (!dictationAvailable() || session.status !== "running") return;
    const onKey = (event: KeyboardEvent) => {
      if (!isDictationShortcut(event) || event.repeat) return;
      const target = event.target as Element | null;
      if (target?.closest?.(".xterm, input, textarea, [contenteditable]")) return;
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
  // A CLI that failed at startup has nothing to resume; offer a fresh start instead.
  const resumable =
    session.status === "exited" &&
    !session.exitCode &&
    ((session.provider === "claude" && !!session.conversationId) ||
      session.provider === "codex");
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
            </span>
          </div>
        </div>
        <div className="session-actions">
          {session.status === "running" ? (
            <>
              {/* Agent control and pasted images stay on this computer. */}
              {!session.hostId ? <AgentControlButton session={session} report={report} /> : null}
              {dictationAvailable() ? (
                <DictationButton
                  viewerId={viewerId}
                  onToggle={() => setDictationToggle((value) => value + 1)}
                />
              ) : null}
              {window.workspace.clipboardImage && !session.hostId ? (
                <button
                  className="button ghost small"
                  title="Save the clipboard image privately and type its path (no Enter)"
                  disabled={!viewerId}
                  onClick={() => setImagePasteRequest((value) => value + 1)}
                >
                  <ImagePlus size={13} />
                  Paste image
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
                Interrupt
              </button>
              <button
                className="button danger small"
                title="End this terminal process"
                disabled={!viewerId}
                onClick={() => {
                  if (
                    confirm(
                      `End this ${name} session? Its process stops; the folder and files are unchanged.`,
                    )
                  ) {
                    onEnded(session);
                    void window.workspace
                      .invoke("session.terminate", { ...identity, viewerId })
                      .catch(report);
                  }
                }}
              >
                <Square size={11} />
                End
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
                      ? "Continue this Claude conversation in a new terminal"
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
          onViewer={setViewerId}
          endedNotice={false}
          imagePasteRequest={imagePasteRequest}
          dictationToggle={dictationToggle}
        />
      </div>
    </section>
  );
}
