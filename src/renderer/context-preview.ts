/** Readable presentation of the approved source; never hide command arguments. */
export function contextPreview(text: string, redactions: readonly [number, number][] = []) {
  let rendered = "", cursor = 0;
  for (const [start, end] of [...redactions].sort((a, b) => a[0] - b[0])) {
    rendered += text.slice(cursor, start) + "[redacted]";
    cursor = end;
  }
  rendered += text.slice(cursor);
  return rendered
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, "Command: $1")
    .replace(/<command-message>([\s\S]*?)<\/command-message>/g, "Command message: $1")
    .replace(/<command-args>([\s\S]*?)<\/command-args>/g, "Arguments: $1")
    .replace(/<\/?local-command-stdout>/g, "");
}
