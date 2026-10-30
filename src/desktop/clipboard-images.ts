import { clipboard, nativeImage } from "electron";
import crypto from "node:crypto";
import type { ClipboardImagePreview } from "../shared/contracts";
import { MAX_ATTACHMENT_BYTES, MAX_IMAGE_SIDE } from "../core/attachments";

/**
 * Reads one clipboard image on request (never polled), decodes it to prove it
 * is an image, and keeps a re-encoded PNG until the owner confirms or discards.
 * No text, file list or other clipboard format is ever returned.
 */
const PREVIEW_TTL_MS = 2 * 60 * 1000;
let held:
  | { token: string; png: Buffer; expires: number; timer: NodeJS.Timeout }
  | undefined;
function release() {
  if (held) clearTimeout(held.timer);
  held = undefined;
}

async function clipboardImageBytes(): Promise<Buffer | null> {
  for (const item of await clipboard.read()) {
    // PNG first, then any other raster type; SVG stays text and is never decoded.
    const type =
      item.types.find((t) => t === "image/png") ||
      item.types.find((t) => t.startsWith("image/") && t !== "image/svg+xml");
    if (!type) continue;
    const blob = await item.getType(type);
    if (!(blob instanceof Blob)) continue;
    if (blob.size > MAX_ATTACHMENT_BYTES)
      throw new Error("The clipboard image is larger than 20 MB");
    return Buffer.from(await blob.arrayBuffer());
  }
  return null;
}

export async function previewClipboardImage(): Promise<ClipboardImagePreview | null> {
  release();
  const bytes = await clipboardImageBytes();
  if (!bytes) return null;
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error("The clipboard image could not be read");
  const { width, height } = image.getSize();
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE)
    throw new Error(`Images larger than ${MAX_IMAGE_SIDE} pixels on a side are not supported`);
  // Re-encoding drops metadata and anything that is not plain pixels.
  const png = image.toPNG();
  if (png.length > MAX_ATTACHMENT_BYTES)
    throw new Error("The clipboard image is larger than 20 MB as PNG");
  const scale = Math.min(1, 480 / Math.max(width, height));
  const thumbnail = (
    scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: "good",
        })
      : image
  ).toDataURL();
  const token = crypto.randomBytes(18).toString("base64url");
  held = {
    token,
    png,
    expires: Date.now() + PREVIEW_TTL_MS,
    timer: setTimeout(release, PREVIEW_TTL_MS).unref(),
  };
  return { token, width, height, bytes: png.length, thumbnail };
}

/** Hands the held PNG over exactly once for the matching, unexpired token. */
export function takeClipboardImage(token: unknown) {
  if (typeof token !== "string" || !held || held.token !== token || held.expires < Date.now())
    throw new Error("This image preview expired. Paste the image again.");
  const png = held.png;
  release();
  return png;
}

export function discardClipboardImage(token: unknown) {
  if (held && held.token === token) release();
}
