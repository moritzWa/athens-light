const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

// Front matter is kept out of the editor and put back untouched on save.
export function splitFrontMatter(text: string): { front: string; body: string } {
  const m = text.match(FRONT_MATTER);
  if (!m) return { front: "", body: text };
  return { front: m[0].replace(/\s+$/, "") + "\n\n", body: text.slice(m[0].length).replace(/^\s+/, "") };
}

// Syntax the editor cannot write back faithfully. Files that use it open read-only.
export function unsupportedSyntax(body: string): string | null {
  const stripped = body.replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
  if (/^[ \t]*<\/?[a-zA-Z!][^>]*>/m.test(stripped)) return "HTML";
  if (/^\[\^[^\]]+\]:/m.test(stripped) || /\[\^[^\]]+\]/.test(stripped)) return "footnotes";
  return null;
}
