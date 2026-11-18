/**
 * Claude conversation identity from the SessionStart hook (roadmap section 3).
 *
 * Every Claude session this version launches carries a per-session
 * SessionStart hook (see `claudeActivitySettings`) that stores the CLI's
 * first start report, bounded and unparsed, as a pane option. This module
 * validates that report. A branch (`--resume <id> --fork-session`) learns its
 * new conversation ID only from here; anything missing or ambiguous is
 * "unknown", never a guess.
 */
import { isConversationId } from "./providers.js";
import type { Session } from "../shared/contracts.js";

export interface SessionStartReport {
  conversationId: string;
  transcriptPath?: string;
  source?: string;
}
/** The validated report, or a reason it cannot be used. */
export function parseSessionStart(raw: string): SessionStartReport | { problem: string } {
  if (!raw) return { problem: "no report" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { problem: "the report is not JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { problem: "the report is not an object" };
  const v = value as Record<string, unknown>;
  if (v.hook_event_name !== "SessionStart") return { problem: "the report is not a SessionStart report" };
  if (!isConversationId(v.session_id)) return { problem: "the report has no valid session_id" };
  if (v.transcript_path !== undefined && typeof v.transcript_path !== "string")
    return { problem: "the report's transcript_path is not text" };
  if (v.source !== undefined && (typeof v.source !== "string" || v.source.length > 40))
    return { problem: "the report's source is not text" };
  return {
    conversationId: v.session_id,
    ...(typeof v.transcript_path === "string" ? { transcriptPath: v.transcript_path } : {}),
    ...(typeof v.source === "string" ? { source: v.source } : {}),
  };
}
/**
 * Whether a report belongs to this session's conversation. A new or resumed
 * session must report the ID it was launched with; a branch must report a
 * different, new ID at startup or resume (never after /clear or compaction).
 */
export function matchReport(
  s: Pick<Session, "conversationId" | "forkedFrom">,
  report: SessionStartReport,
): { ok: true } | { ok: false; problem: string } {
  if (s.forkedFrom) {
    if (report.conversationId === s.forkedFrom.conversationId)
      return { ok: false, problem: "the CLI reported the original conversation, not a new branch" };
    if (report.source !== undefined && !["startup", "resume"].includes(report.source))
      return { ok: false, problem: `the first report came from "${report.source}", not from starting the branch` };
    return { ok: true };
  }
  if (!s.conversationId || report.conversationId !== s.conversationId)
    return { ok: false, problem: "the CLI reported a different conversation than it was started with" };
  return { ok: true };
}
