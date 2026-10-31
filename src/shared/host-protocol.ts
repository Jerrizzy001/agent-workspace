/**
 * Framed stdio protocol between the desktop's host router and the SSH helper
 * (`src/server/stdio-host.ts`) running on an execution host.
 *
 * Wire format: the helper first writes PREAMBLE (so any text a login profile
 * prints before it is skipped), then both directions carry frames of a 4-byte
 * big-endian length followed by that many bytes of UTF-8 JSON. Every frame is
 * one object with a string kind `k`. Terminal bytes travel base64-encoded.
 * Sizes are bounded and unknown kinds are a protocol violation that ends the
 * connection; neither side ever executes anything a frame names other than
 * the fixed operations listed here.
 */
export const PROTOCOL_VERSION = 1;
/** Oldest protocol this build can still speak. */
export const PROTOCOL_MIN = 1;
export const PREAMBLE = "\nAW-STDIO-HOST\n";
/** Largest frame either side accepts (a 2 MiB file plus JSON escaping fits). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Junk tolerated before the preamble (login-profile banners). */
export const MAX_PREAMBLE_SEEK = 64 * 1024;
/** Largest base64 terminal chunk in one event. */
export const MAX_TERMINAL_B64 = 2 * 1024 * 1024;
/** Requests the helper runs at once; more are refused, never queued unbounded. */
export const MAX_IN_FLIGHT = 64;

/** Frames the helper may send. */
export const HELPER_KINDS = ["hello", "ready", "res", "evt", "fatal"] as const;
/** Frames the desktop may send. */
export const LOCAL_KINDS = ["start", "req", "bye"] as const;
/** Operations a `req` frame may name. `invoke` is further limited to remote-allowed commands. */
export const HELPER_OPS = ["invoke", "browse", "register", "hide"] as const;
export type HelperOp = (typeof HELPER_OPS)[number];
/** Core events the helper may forward. Anything else is dropped by the desktop. */
export const HELPER_EVENTS = [
  "snapshot",
  "terminal.data",
  "terminal.resync",
  "session.exit",
] as const;

export interface HostTool {
  name: "node" | "tmux" | "git" | "claude" | "codex";
  available: boolean;
  /** First line of `--version`, or the reason it is unavailable. */
  detail: string;
}
export interface HostHello {
  k: "hello";
  protocol: { min: number; max: number };
  helperVersion: string;
  platform: string;
  arch: string;
  /** Schema version this helper's core writes. */
  schema: number;
  /** Schema version of the helper's existing data, 0 when there is none yet. */
  storeSchema: number;
  /** Persistent random ID of this helper data folder, empty before first start. */
  hostId: string;
  tools: HostTool[];
}

export class ProtocolError extends Error {}

export function encodeFrame(message: { k: string } & Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_FRAME_BYTES)
    throw new ProtocolError("Message exceeds the frame limit");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Incremental frame reader. `seekPreamble` skips bounded leading text until
 * PREAMBLE (the desktop side reading a helper); without it the first byte must
 * start a frame (the helper reading the desktop).
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private seeking: boolean;
  private skipped = 0;
  constructor(
    private allowedKinds: readonly string[],
    options: { seekPreamble?: boolean; maxFrame?: number } = {},
  ) {
    this.seeking = !!options.seekPreamble;
    this.maxFrame = options.maxFrame ?? MAX_FRAME_BYTES;
  }
  private maxFrame: number;
  /** Returns complete messages; throws ProtocolError on any violation. */
  push(chunk: Buffer): ({ k: string } & Record<string, any>)[] {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    const out: ({ k: string } & Record<string, any>)[] = [];
    if (this.seeking) {
      const at = this.buffer.indexOf(PREAMBLE, 0, "utf8");
      if (at < 0) {
        const keep = Buffer.byteLength(PREAMBLE) - 1;
        if (this.skipped + this.buffer.length > MAX_PREAMBLE_SEEK + keep)
          throw new ProtocolError(
            "The host printed unexpected output instead of starting the helper",
          );
        // Keep only a possible partial preamble at the end.
        if (this.buffer.length > keep) {
          this.skipped += this.buffer.length - keep;
          this.buffer = this.buffer.subarray(this.buffer.length - keep);
        }
        return out;
      }
      this.buffer = this.buffer.subarray(at + Buffer.byteLength(PREAMBLE));
      this.seeking = false;
    }
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE(0);
      if (size === 0 || size > this.maxFrame)
        throw new ProtocolError("Frame size is outside the allowed range");
      if (this.buffer.length < 4 + size) break;
      const body = this.buffer.subarray(4, 4 + size);
      this.buffer = this.buffer.subarray(4 + size);
      let message: unknown;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        throw new ProtocolError("Frame is not valid JSON");
      }
      if (
        !message ||
        typeof message !== "object" ||
        Array.isArray(message) ||
        typeof (message as { k?: unknown }).k !== "string"
      )
        throw new ProtocolError("Frame has no message kind");
      if (!this.allowedKinds.includes((message as { k: string }).k))
        throw new ProtocolError(
          "Unsupported message kind: " +
            String((message as { k: string }).k).slice(0, 40),
        );
      out.push(message as { k: string } & Record<string, any>);
    }
    if (this.buffer.length > 4 + this.maxFrame)
      throw new ProtocolError("Frame buffer overflow");
    return out;
  }
}

/**
 * Remote records keep their own IDs; the desktop shows them under an opaque
 * per-host prefix so they can never collide with, or be mistaken for, local
 * records. Old local IDs are never rewritten.
 */
const QUALIFIED = /^ssh-([0-9a-f]{8})-([A-Za-z0-9][A-Za-z0-9_-]{0,99})$/;
export const REMOTE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
export const HOST_ID = /^[0-9a-f]{8}$/;
export function qualifyId(hostId: string, remoteId: string) {
  if (!HOST_ID.test(hostId) || !REMOTE_ID.test(remoteId))
    throw new ProtocolError("Invalid remote identifier");
  return `ssh-${hostId}-${remoteId}`;
}
export function parseQualifiedId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const match = QUALIFIED.exec(value);
  return match ? { hostId: match[1]!, remoteId: match[2]! } : undefined;
}
