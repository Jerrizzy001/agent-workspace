/**
 * Text that the app types into a terminal on the owner's behalf. Nothing here
 * can produce CR, LF or another control byte unless multiline text was asked
 * for, so a paste never submits or runs anything by itself.
 */

// C0/C1 controls (incl. ESC, CR, LF, DEL), format characters such as bidi
// overrides and zero-width joiners, and line/paragraph separators.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// Characters a POSIX shell treats as plain word characters.
const PLAIN = /[A-Za-z0-9_\-./,+@%:=]/;

/**
 * One absolute path, backslash-escaped like a terminal's file drag-and-drop:
 * safe for bash, zsh and sh as a single word, and the form agent CLIs accept
 * for dropped files. Paths with control characters are refused, not altered.
 */
export function shellEscapePath(path: string) {
  if (typeof path !== "string" || !path.startsWith("/"))
    throw new Error("Only an absolute path can be pasted");
  if (UNSAFE.test(path))
    throw new Error("This path contains characters that cannot be pasted safely");
  let out = "";
  for (const char of path)
    out +=
      PLAIN.test(char) || (char.codePointAt(0)! > 0x7f && !/\s/u.test(char))
        ? char
        : "\\" + char;
  return out;
}

/** Plain text for the terminal: control bytes removed, one line by default. */
export function sanitizePasteText(text: string, options: { multiline?: boolean } = {}) {
  const normalized = String(text)
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\n/g, options.multiline ? "\n" : " ");
  return [...normalized]
    .filter((char) => char === "\n" || !UNSAFE.test(char))
    .join("");
}
