import { createPortal } from "react-dom";
import { ImagePlus, X } from "lucide-react";
import type { ClipboardImagePreview } from "../shared/contracts";

const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? Math.max(1, Math.round(bytes / 1024)) + " KB"
    : (bytes / 1024 / 1024).toFixed(1) + " MB";

/** Confirms one clipboard image before it is saved and its path typed. */
export function ImagePastePreview({
  preview,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  preview: ClipboardImagePreview;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Portaled so a terminal inside a transformed canvas node still gets a full-window dialog.
  return createPortal(
    <div
      className="modal-backdrop"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        onCancel();
      }}
    >
      <form
        className="modal image-paste"
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-paste-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onConfirm();
        }}
      >
        <header>
          <div>
            <div className="eyebrow">Terminal</div>
            <h2 id="image-paste-title">Paste image as a file path</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onCancel}
            aria-label="Cancel"
          >
            <X size={18} />
          </button>
        </header>
        <img
          className="image-paste-thumb"
          src={preview.thumbnail}
          alt="Clipboard image preview"
        />
        <p className="modal-context">
          PNG · {preview.width} × {preview.height} · {size(preview.bytes)}
        </p>
        <p className="muted image-paste-note">
          Saved privately on this computer; only its path is typed into the
          terminal — nothing is sent until you press Enter. Saved images are
          removed 7 days after the session ends.
        </p>
        {error ? (
          <div className="inline-error" role="alert">
            {error}
          </div>
        ) : null}
        <footer>
          <button type="button" className="button ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="button primary" autoFocus disabled={busy}>
            <ImagePlus size={15} />
            {busy ? "Saving…" : "Paste path"}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
