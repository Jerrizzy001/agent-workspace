import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Limits shared by the desktop clipboard broker and the core writer. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 8192;
/** Images of a session that ended longer ago than this are removed. */
export const ATTACHMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export interface AttachmentRecord {
  id: string;
  sessionId: string;
  generation: number;
  mime: "image/png";
  path: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  /** First time cleanup saw the session ended; retention counts from here. */
  sessionEndedAt?: string;
}
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Checks the PNG signature and header; the broker already re-encoded it. */
export function pngSize(data: Uint8Array) {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("latin1", 12, 16) !== "IHDR"
  )
    throw new Error("Attachment is not a PNG image");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!width || !height || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE)
    throw new Error("Image dimensions are too large");
  return { width, height };
}

/** A private 0700 directory that is exactly where expected, never a symlink. */
function privateDirectory(target: string) {
  try {
    fs.mkdirSync(target, { mode: 0o700 });
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
  }
  const info = fs.lstatSync(target);
  if (!info.isDirectory() || fs.realpathSync(target) !== target)
    throw new Error("Attachment folder is not a private directory");
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new Error("Attachment folder belongs to another user");
  fs.chmodSync(target, 0o700);
}

export function attachmentRoot(dataDir: string) {
  return path.join(dataDir, "attachments");
}

/** Writes bytes to a new randomly named file; never follows links or overwrites. */
export function writeAttachment(
  dataDir: string,
  sessionId: string,
  data: Uint8Array,
) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(sessionId))
    throw new Error("Invalid session id");
  if (!data.byteLength || data.byteLength > MAX_ATTACHMENT_BYTES)
    throw new Error("Image exceeds the 20 MB limit");
  pngSize(data);
  const root = attachmentRoot(dataDir);
  privateDirectory(root);
  const folder = path.join(root, sessionId);
  privateDirectory(folder);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const file = path.join(
    folder,
    `screenshot-${stamp}-${crypto.randomBytes(6).toString("hex")}.png`,
  );
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  return {
    path: file,
    bytes: data.byteLength,
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
  };
}

/** Removes one saved image and its session folder once empty. */
export function removeAttachmentFile(dataDir: string, record: AttachmentRecord) {
  const folder = path.join(attachmentRoot(dataDir), record.sessionId);
  // Only ever delete inside the private root, whatever the record says.
  if (path.dirname(record.path) === folder)
    fs.rmSync(record.path, { force: true });
  try {
    fs.rmdirSync(folder);
  } catch {}
}
