/**
 * Claude conversation transcripts (roadmap section 3), adapter version 1.
 *
 * The only file this module reads is the `transcript_path` Claude reported in
 * its documented SessionStart hook input, and only after checking that its
 * real path is a regular file named `<conversation id>.jsonl`, owned by this
 * user, inside the source profile's approved storage root
 * (`<config folder>/projects`). It never scans account history and never
 * accepts a path from the renderer or an agent.
 *
 * Parsing is incremental and bounded. An incomplete trailing line is left
 * for later; anything structurally unexpected fails closed (schema drift).
 * Text is plain: terminal controls, bidi overrides and zero-width characters
 * are removed. It stays untrusted data.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { TranscriptExportInfo } from "../shared/contracts.js";

export const CLAUDE_TRANSCRIPT_ADAPTER = "claude-code-jsonl/1";
/** Largest provider file this adapter reads. */
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
/** Largest single JSONL record. */
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;
/** Export text kept (the most recent messages). */
export const MAX_EXPORT_CHARS = 192 * 1024;
const MAX_MESSAGE_CHARS = 24 * 1024;
const CHUNK = 1024 * 1024;

export class TranscriptError extends Error {
  constructor(
    public code: "unavailable" | "unsafe_path" | "schema_drift" | "too_large",
    message: string,
  ) {
    super(message);
  }
}

/** Plain text: no escape sequences, control, zero-width or bidi characters. */
export function plainText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "");
}

/**
 * The approved real path of a reported transcript, or a TranscriptError.
 * `root` is the profile's storage root; symlinks may not lead outside it.
 */
export function approvedTranscriptPath(root: string, candidate: unknown, conversationId: string) {
  if (typeof candidate !== "string" || !candidate || candidate.length > 4096 || candidate.includes("\0"))
    throw new TranscriptError("unsafe_path", "Claude did not report a usable transcript file");
  if (!path.isAbsolute(candidate))
    throw new TranscriptError("unsafe_path", "The reported transcript path is not absolute");
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    throw new TranscriptError("unavailable", "This profile has no Claude conversation storage yet");
  }
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new TranscriptError("unavailable", "The transcript file does not exist (yet)");
  }
  if (!real.startsWith(realRoot + path.sep))
    throw new TranscriptError("unsafe_path", "The transcript file is outside this profile's Claude storage");
  if (path.basename(real) !== conversationId + ".jsonl")
    throw new TranscriptError("unsafe_path", "The transcript file is not named after its conversation");
  const stat = fs.lstatSync(real);
  if (!stat.isFile())
    throw new TranscriptError("unsafe_path", "The transcript is not a regular file");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw new TranscriptError("unsafe_path", "The transcript file belongs to another user");
  return real;
}

interface Message {
  role: "user" | "assistant";
  text: string;
}
interface Parsed {
  dev: number;
  ino: number;
  /** Bytes consumed: just after the last whole record. */
  offset: number;
  head: string;
  hash: crypto.Hash;
  messages: Message[];
  pendingBytes: number;
  /** Older messages were dropped from memory to stay bounded. */
  dropped: boolean;
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …[cut]" : s);
const drift = (detail: string) =>
  new TranscriptError(
    "schema_drift",
    `This Claude version writes transcripts in a format this app does not understand (${detail}). Nothing was exported.`,
  );

function blockText(block: unknown): string | undefined {
  if (!block || typeof block !== "object" || Array.isArray(block)) throw drift("content block");
  const b = block as Record<string, unknown>;
  if (typeof b.type !== "string") throw drift("content block type");
  switch (b.type) {
    case "text":
      if (typeof b.text !== "string") throw drift("text block");
      return b.text;
    case "thinking":
    case "redacted_thinking":
      return undefined;
    case "tool_use":
      return `[tool call: ${typeof b.name === "string" ? clip(b.name, 80) : "tool"}${
        b.input !== undefined ? " " + clip(JSON.stringify(b.input) ?? "", 300) : ""
      }]`;
    case "tool_result": {
      const content = b.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((c) =>
                  c && typeof c === "object" && (c as any).type === "text" && typeof (c as any).text === "string"
                    ? (c as any).text
                    : "",
                )
                .join("\n")
            : "";
      return `[tool result${b.is_error === true ? " (error)" : ""}] ${clip(text, 600)}`;
    }
    case "image":
      return "[image]";
    case "document":
      return "[document]";
    default:
      return `[${clip(b.type, 40)}]`;
  }
}
/** One JSONL record to a message, nothing (not conversation text) or drift. */
function recordMessage(line: string): Message | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw drift("a line is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw drift("a record is not an object");
  const r = value as Record<string, unknown>;
  if (typeof r.type !== "string") throw drift("a record has no type");
  if (r.type !== "user" && r.type !== "assistant") return undefined;
  // Command wrappers and other meta records are not conversation.
  if (r.isMeta === true) return undefined;
  const m = r.message;
  if (!m || typeof m !== "object" || Array.isArray(m)) throw drift("a message record has no message");
  const message = m as Record<string, unknown>;
  if (message.role !== r.type) throw drift("message role");
  const content = message.content;
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content))
    text = content
      .map(blockText)
      .filter((t): t is string => t !== undefined && t !== "")
      .join("\n");
  else throw drift("message content");
  text = plainText(text).trim();
  if (!text) return undefined;
  return { role: r.type, text: clip(text, MAX_MESSAGE_CHARS) };
}

/** Incremental reader: one cache entry per transcript file. */
export function createTranscriptReader() {
  const cache = new Map<string, Parsed>();
  function read(file: string): Parsed {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new TranscriptError("unsafe_path", "The transcript is not a regular file");
      if (stat.size > MAX_SOURCE_BYTES)
        throw new TranscriptError(
          "too_large",
          `The transcript is larger than ${MAX_SOURCE_BYTES / 1024 / 1024} MiB; this version does not export it`,
        );
      const headBytes = Buffer.alloc(Math.min(4096, stat.size));
      fs.readSync(fd, headBytes, 0, headBytes.length, 0);
      let state = cache.get(file);
      const head = (n: number) => headBytes.subarray(0, Math.min(n, headBytes.length)).toString("latin1");
      // Continue only when it is the same file, it did not shrink and its start is unchanged.
      if (
        !state ||
        state.dev !== stat.dev ||
        state.ino !== stat.ino ||
        stat.size < state.offset ||
        head(state.head.length) !== state.head
      )
        state = {
          dev: stat.dev,
          ino: stat.ino,
          offset: 0,
          head: "",
          hash: crypto.createHash("sha256"),
          messages: [],
          pendingBytes: 0,
          dropped: false,
        };
      // Work on copies so a failure leaves the cached state untouched.
      const hash = state.hash.copy();
      const messages = [...state.messages];
      let offset = state.offset;
      let carry = Buffer.alloc(0);
      let position = offset;
      while (position < stat.size) {
        const length = Math.min(CHUNK, stat.size - position);
        const chunk = Buffer.alloc(length);
        const got = fs.readSync(fd, chunk, 0, length, position);
        if (got <= 0) break;
        position += got;
        let data = carry.length ? Buffer.concat([carry, chunk.subarray(0, got)]) : chunk.subarray(0, got);
        let start = 0;
        for (let nl = data.indexOf(10, start); nl >= 0; nl = data.indexOf(10, start)) {
          const lineBytes = data.subarray(start, nl + 1);
          const line = lineBytes.toString("utf8").trim();
          if (line) {
            const message = recordMessage(line);
            if (message) messages.push(message);
          }
          hash.update(lineBytes);
          offset += lineBytes.length;
          start = nl + 1;
        }
        carry = Buffer.from(data.subarray(start));
        if (carry.length > MAX_RECORD_BYTES) throw drift("a record is too large");
      }
      // Keep the message list bounded in memory as well.
      let chars = 0;
      let keepFrom = messages.length;
      while (keepFrom > 0 && chars <= MAX_EXPORT_CHARS * 2) chars += messages[--keepFrom]!.text.length;
      const next: Parsed = {
        dev: stat.dev,
        ino: stat.ino,
        offset,
        head: head(Math.min(offset, 4096)),
        hash,
        messages: messages.slice(keepFrom),
        pendingBytes: carry.length,
        dropped: state.dropped || keepFrom > 0,
      };
      cache.set(file, next);
      if (cache.size > 64) cache.delete(cache.keys().next().value!);
      return next;
    } finally {
      fs.closeSync(fd);
    }
  }
  /**
   * An export of an approved transcript file. `ended` says whether the
   * source session has ended; a running session's export is always partial.
   */
  function exportOf(file: string, ended: boolean): TranscriptExportInfo & { text: string } {
    const parsed = read(file);
    const parts: string[] = [];
    let total = 0;
    let truncated = parsed.dropped;
    let count = 0;
    for (let i = parsed.messages.length - 1; i >= 0; i--) {
      const m = parsed.messages[i]!;
      const part = `## ${m.role === "user" ? "User" : "Assistant"}\n${m.text}\n`;
      if (total + part.length + 1 > MAX_EXPORT_CHARS) {
        truncated = true;
        break;
      }
      parts.push(part);
      total += part.length + 1;
      count++;
    }
    const text = parts.reverse().join("\n");
    const reasons: string[] = [];
    if (!ended) reasons.push("the source session is still running, so later messages may be missing");
    if (parsed.pendingBytes) reasons.push("the last record was still being written");
    if (truncated) reasons.push(`older messages were left out to stay within ${MAX_EXPORT_CHARS / 1024} KiB`);
    return {
      adapter: CLAUDE_TRANSCRIPT_ADAPTER,
      complete: !reasons.length,
      ...(reasons.length ? { partialReason: reasons.join("; ") } : {}),
      watermark: parsed.offset,
      bytes: parsed.offset,
      sourceHash: parsed.hash.copy().digest("hex"),
      textHash: crypto.createHash("sha256").update(text).digest("hex"),
      messages: count,
      truncated,
      textBytes: Buffer.byteLength(text),
      text,
    };
  }
  return { exportOf };
}

/** Applies owner redactions (UTF-16 ranges in the previewed text). */
export function redact(text: string, ranges: unknown) {
  if (ranges === undefined) return { text, count: 0 };
  if (!Array.isArray(ranges) || ranges.length > 200) throw new Error("Invalid redactions");
  const spans = ranges.map((r) => {
    if (
      !Array.isArray(r) ||
      r.length !== 2 ||
      !Number.isSafeInteger(r[0]) ||
      !Number.isSafeInteger(r[1]) ||
      r[0] < 0 ||
      r[1] <= r[0] ||
      r[1] > text.length
    )
      throw new Error("Invalid redaction");
    return [r[0] as number, r[1] as number] as const;
  });
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [start, end] of spans) {
    if (start < at) throw new Error("Redactions overlap");
    out += text.slice(at, start) + "[redacted]";
    at = end;
  }
  return { text: out + text.slice(at), count: spans.length };
}
