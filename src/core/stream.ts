import type { CoreEvent } from "../shared/contracts.js";
/** Per-viewer unacknowledged output is bounded. Overflow explicitly requires a redraw. */
export class TerminalStream {
  private sequence = 0;
  private viewers = new Map<
    string,
    {
      pending: { sequence: number; bytes: number }[];
      bytes: number;
      resync: boolean;
    }
  >();
  constructor(
    private sessionId: string,
    private emit: (event: CoreEvent) => void,
  ) {}
  add(viewerId: string) {
    this.viewers.set(viewerId, { pending: [], bytes: 0, resync: false });
  }
  remove(viewerId: string) {
    this.viewers.delete(viewerId);
  }
  ack(viewerId: string, sequence: number) {
    const v = this.viewers.get(viewerId);
    if (!v) throw new Error("Viewer is not attached");
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence > this.sequence
    )
      throw new Error("Invalid output acknowledgment");
    while (v.pending[0] && v.pending[0].sequence <= sequence) {
      v.bytes -= v.pending.shift()!.bytes;
    }
  }
  write(data: string) {
    const bytes = Buffer.byteLength(data);
    if (bytes === 0) return;
    for (const [viewerId, v] of this.viewers) {
      if (v.resync) continue;
      if (v.bytes + bytes > 262144 || v.pending.length >= 4096) {
        v.pending = [];
        v.bytes = 0;
        v.resync = true;
        this.emit({
          type: "terminal.resync",
          sessionId: this.sessionId,
          viewerId,
        });
        continue;
      }
      const sequence = ++this.sequence;
      v.bytes += bytes;
      v.pending.push({ sequence, bytes });
      this.emit({
        type: "terminal.data",
        sessionId: this.sessionId,
        viewerId,
        sequence,
        data,
      });
    }
  }
}
