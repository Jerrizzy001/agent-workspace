import { useState } from "react";
import { Check, CircleAlert, Copy, RefreshCw } from "lucide-react";
import type { Capability } from "../shared/contracts";

/** One source for install commands, shared with the launch notices. */
export const installHints: Record<string, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
};
const mac = /Mac/i.test(navigator.platform);
const TOOLS: {
  name: string;
  label: string;
  role: string;
  install: string;
  after: string;
  note?: string;
  required?: boolean;
}[] = [
  {
    name: "tmux",
    label: "tmux",
    role: "Keeps sessions running when the window closes",
    install: mac ? "brew install tmux" : "sudo apt install tmux",
    note: mac ? "" : "Or use your distribution's package manager.",
    after: "Then quit and reopen Agent Workspace.",
    required: true,
  },
  {
    name: "claude",
    label: "Claude Code",
    role: "The Claude agent",
    install: installHints.claude!,
    after: "Then run claude once in a terminal to sign in.",
  },
  {
    name: "codex",
    label: "Codex CLI",
    role: "The Codex agent",
    install: installHints.codex!,
    after: "Then run codex once in a terminal to sign in.",
  },
  {
    name: "git",
    label: "Git",
    role: "Changes, review and worktrees (optional)",
    install: mac ? "xcode-select --install" : "sudo apt install git",
    note: mac ? "" : "Or use your distribution's package manager.",
    after: "Folders still open without it.",
  },
];

/**
 * What this computer has, shown before the first folder or whenever tmux is
 * missing. It never installs or signs in on the user's behalf.
 */
export function FirstRunChecklist({
  capabilities,
  onCheckAgain,
}: {
  capabilities: Capability[];
  onCheckAgain: () => Promise<void> | void;
}) {
  const [copied, setCopied] = useState("");
  const [checking, setChecking] = useState(false);
  const ready = TOOLS.filter(
    (t) => capabilities.find((c) => c.name === t.name)?.available,
  ).length;
  return (
    <section className="first-run" aria-labelledby="first-run-heading">
      <header>
        <div>
          <h2 id="first-run-heading">Set up this computer</h2>
          <p>
            {ready} of {TOOLS.length} ready. Agent Workspace uses the tools you
            already have; it never installs or signs in for you.
          </p>
        </div>
        <button
          className="button small"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            try {
              await onCheckAgain();
            } finally {
              setChecking(false);
            }
          }}
        >
          <RefreshCw size={13} className={checking ? "spin" : undefined} />
          Check again
        </button>
      </header>
      <ul>
        {TOOLS.map((tool) => {
          const cap = capabilities.find((c) => c.name === tool.name);
          const ok = !!cap?.available;
          return (
            <li key={tool.name} className={ok ? "is-ready" : "is-missing"}>
              <span className="first-run-icon" aria-hidden="true">
                {ok ? <Check size={15} /> : <CircleAlert size={15} />}
              </span>
              <span className="first-run-text">
                <strong>
                  {tool.label}
                  <span className="first-run-state">
                    {ok
                      ? " · Installed"
                      : tool.required
                        ? " · Not installed (required)"
                        : " · Not installed"}
                  </span>
                </strong>
                <small>
                  {tool.role}
                  {ok && cap?.detail.startsWith("/") ? ` · ${cap.detail}` : ""}
                </small>
                {!ok ? (
                  <small>
                    Run <code>{tool.install}</code> in a terminal.{" "}
                    {tool.note ? tool.note + " " : ""}
                    {tool.after}
                  </small>
                ) : null}
              </span>
              {!ok ? (
                <button
                  className="button ghost small"
                  aria-label={`Copy the ${tool.label} install command`}
                  onClick={() =>
                    void navigator.clipboard
                      ?.writeText(tool.install)
                      .then(() => setCopied(tool.name))
                      .catch(() => {})
                  }
                >
                  <Copy size={13} />
                  {copied === tool.name ? "Copied" : "Copy command"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
