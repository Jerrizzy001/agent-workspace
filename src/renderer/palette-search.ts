export interface PaletteEntry {
  label: string;
  hint?: string;
  /** Extra search words that are not shown, e.g. "hosts" for SSH. */
  keywords?: string;
}

const words = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Every query word must start a word of the entry (or, failing that, appear
 * inside one), in any order. "ssh host" finds "SSH hosts", "set term" finds
 * "Show terminals". Earlier, label-start and word-start matches rank first.
 */
export function paletteScore(entry: PaletteEntry, query: string) {
  const terms = words(query);
  if (!terms.length) return 1;
  const label = words(entry.label);
  const all = [
    ...label,
    ...words(entry.hint || ""),
    ...words(entry.keywords || ""),
  ];
  let score = 0;
  for (const term of terms) {
    const start = all.findIndex((w) => w.startsWith(term));
    if (start >= 0) {
      score += start < label.length ? 3 : 2;
      if (start === 0) score += 1;
      continue;
    }
    if (all.some((w) => w.includes(term))) score += 1;
    else return 0;
  }
  return score;
}

export function paletteMatches<T extends PaletteEntry>(
  items: T[],
  query: string,
) {
  return items
    .map((item, index) => ({ item, index, score: paletteScore(item, query) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((m) => m.item);
}
