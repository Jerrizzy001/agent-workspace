import { useState } from "react";
import { History, Play, Square, Zap } from "lucide-react";
import type { Project, Session } from "../shared/contracts";
import { TerminalView } from "./TerminalView";
import { providerName, sessionLocation, sessionState } from "./sessions";
import { ProviderGlyph, StatusBadge } from "./ui";

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
            <strong>
              {title}
              <StatusBadge session={session} />
            </strong>
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
      <div className="session-terminal">
        <TerminalView
          key={session.id}
          session={session}
          onViewer={setViewerId}
          endedNotice={false}
        />
      </div>
    </section>
  );
}
