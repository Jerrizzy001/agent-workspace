import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, X } from "lucide-react";
import type { Session } from "../shared/contracts";
import {
  CONTROLLER_VERBS,
  GRANT_DEFAULTS,
  type AgentControlState,
  type ControllerVerb,
} from "../shared/controller-contracts";
import "./agent-control.css";

const VERB_LABELS: Record<ControllerVerb, { label: string; detail: string }> = {
  status: { label: "Read status", detail: "awctl status: this folder's sessions, notes and canvas layout" },
  "note.create": { label: "Create notes", detail: "awctl note create (plain text, at most 50)" },
  "note.update": { label: "Edit notes", detail: "awctl note update; refused if the note changed since the agent read it" },
  "canvas.place": { label: "Move canvas cards", detail: "awctl canvas place; refused if the layout changed since the agent read it" },
  open: { label: "Open sessions", detail: "awctl open: Claude, Codex or a shell here, with no first message and no control of their own" },
};
const EXPIRY = [15, 30, 60, 120, 240];
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Desktop owner only: grant this session's agent the `awctl` CLI. Hidden in
 * remote browsers, which have no route to grant control.
 */
export function AgentControlButton({
  session,
  report,
}: {
  session: Session;
  report: (error: unknown) => void;
}) {
  const api = window.workspace.agentControl;
  const [state, setState] = useState<AgentControlState | null>(null);
  const [open, setOpen] = useState(false);
  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setState(await api.list({ sessionId: session.id }));
    } catch {
      /* The next poll or action reports a persistent problem. */
    }
  }, [api, session.id]);
  useEffect(() => {
    if (!api || session.status !== "running") return;
    void refresh();
    // Grants expire and agents act on their own; keep the summary current.
    const timer = setInterval(() => void refresh(), open ? 2000 : 8000);
    return () => clearInterval(timer);
  }, [api, refresh, open, session.status]);
  if (!api || session.status !== "running") return null;
  const grant = state?.grant;
  return (
    <>
      <button
        className={"button small " + (grant ? "agent-control-on" : "ghost")}
        title={
          grant
            ? `Agent control is on until ${time(grant.expiresAt)}`
            : "Let this session's agent use awctl on this folder's canvas"
        }
        aria-pressed={!!grant}
        onClick={() => setOpen(true)}
      >
        <Bot size={13} />
        {grant ? "Agent control on" : "Agent control"}
      </button>
      {open ? (
        <AgentControlDialog
          session={session}
          state={state}
          setState={setState}
          report={report}
          close={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function AgentControlDialog({
  session,
  state,
  setState,
  report,
  close,
}: {
  session: Session;
  state: AgentControlState | null;
  setState: (state: AgentControlState) => void;
  report: (error: unknown) => void;
  close: () => void;
}) {
  const api = window.workspace.agentControl!;
  const [verbs, setVerbs] = useState<ControllerVerb[]>(GRANT_DEFAULTS.verbs);
  const [minutes, setMinutes] = useState(GRANT_DEFAULTS.expiresInMinutes);
  const [openLimit, setOpenLimit] = useState(GRANT_DEFAULTS.openLimit);
  const [busy, setBusy] = useState(false);
  const grant = state?.grant;
  const act = async (work: () => Promise<AgentControlState>) => {
    setBusy(true);
    try {
      setState(await work());
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      }}
    >
      <section className="modal agent-control" role="dialog" aria-modal="true" aria-labelledby="agent-control-title">
        <header>
          <div>
            <div className="eyebrow">This session</div>
            <h2 id="agent-control-title">Agent control</h2>
          </div>
          <button className="icon-button" onClick={close} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <p className="muted">
          Lets the program in this terminal run <code>awctl</code> to read this folder's canvas and make the changes
          you allow below. It cannot type into terminals, end sessions, change files or Git, or grant itself more.
          Other programs running as you could also read the grant while it lasts.
        </p>
        {grant ? (
          <div className="agent-control-grant" role="status">
            <strong>On until {time(grant.expiresAt)}</strong>
            <span className="muted">
              Allowed: {grant.verbs.map((v) => VERB_LABELS[v].label.toLowerCase()).join(", ")}
              {grant.verbs.includes("open")
                ? ` · ${grant.openSessions} of ${grant.openLimit} opened sessions running`
                : ""}
              {` · ${grant.notesCreated} note${grant.notesCreated === 1 ? "" : "s"} created`}
            </span>
            <button
              className="button danger small"
              disabled={busy}
              onClick={() => void act(() => api.revoke({ sessionId: session.id }))}
            >
              Revoke
            </button>
          </div>
        ) : state?.unavailableReason ? (
          <p className="agent-control-unavailable">{state.unavailableReason}</p>
        ) : (
          <fieldset className="agent-control-form" disabled={busy || !state}>
            <legend>Allow</legend>
            {CONTROLLER_VERBS.map((verb) => (
              <label key={verb} className="agent-control-verb">
                <input
                  type="checkbox"
                  checked={verbs.includes(verb)}
                  onChange={(e) =>
                    setVerbs((current) =>
                      e.target.checked ? [...current, verb] : current.filter((v) => v !== verb),
                    )
                  }
                />
                <span>
                  {VERB_LABELS[verb].label}
                  <span className="muted">{VERB_LABELS[verb].detail}</span>
                </span>
              </label>
            ))}
            <div className="agent-control-limits">
              <label>
                Expires after
                <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                  {EXPIRY.map((m) => (
                    <option key={m} value={m}>
                      {m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? "s" : ""}`}
                    </option>
                  ))}
                </select>
              </label>
              {verbs.includes("open") ? (
                <label>
                  Opened sessions running at once
                  <select value={openLimit} onChange={(e) => setOpenLimit(Number(e.target.value))}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            <footer>
              <button
                className="button primary"
                disabled={!verbs.length}
                onClick={() =>
                  void act(() =>
                    api.grant({
                      sessionId: session.id,
                      generation: session.generation,
                      verbs,
                      expiresInMinutes: minutes,
                      ...(verbs.includes("open") ? { openLimit } : {}),
                    }),
                  )
                }
              >
                Grant control
              </button>
            </footer>
          </fieldset>
        )}
        <section className="agent-control-audit" aria-label="Recent agent actions">
          <h3>Recent actions</h3>
          {state?.audit.length ? (
            <ol>
              {state.audit.map((entry) => (
                <li key={entry.id} className={"outcome-" + entry.outcome}>
                  <time dateTime={entry.at}>{time(entry.at)}</time>
                  <code>{entry.action}</code>
                  <span>{entry.detail || entry.outcome}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">None yet.</p>
          )}
        </section>
      </section>
    </div>,
    document.body,
  );
}
