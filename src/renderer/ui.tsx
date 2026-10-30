import { Hexagon, Sparkles, SquareTerminal } from "lucide-react";
import type { Provider, Session } from "../shared/contracts";
import { sessionState } from "./sessions";

export function ProviderGlyph({
  provider,
  size = 15,
}: {
  provider: Provider;
  size?: number;
}) {
  const Icon =
    provider === "claude"
      ? Sparkles
      : provider === "codex"
        ? Hexagon
        : SquareTerminal;
  return (
    <span className={"glyph glyph-" + provider} aria-hidden="true">
      <Icon size={size} strokeWidth={1.9} />
    </span>
  );
}

export function StatusBadge({
  session,
  compact = false,
}: {
  session: Session;
  compact?: boolean;
}) {
  const state = sessionState(session);
  return (
    <span
      className={"status-badge tone-" + state.tone + (compact ? " compact" : "")}
      title={state.detail}
    >
      <span className="status-light" aria-hidden="true" />
      {compact ? <span className="sr-only">{state.label}</span> : state.label}
    </span>
  );
}

export function BrandMark({ size = 28 }: { size?: number }) {
  // Three nodes joined by a path: sessions placed in one workspace.
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <rect x="1" y="1" width="30" height="30" rx="9" className="brand-tile" />
      <path
        d="M10 21.5 L16 10.5 L22 21.5"
        className="brand-path"
        fill="none"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="21.5" r="3" className="brand-node" />
      <circle cx="16" cy="10.5" r="3" className="brand-node accent" />
      <circle cx="22" cy="21.5" r="3" className="brand-node" />
    </svg>
  );
}
