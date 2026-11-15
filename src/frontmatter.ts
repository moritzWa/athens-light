import { marked } from "marked";
import { isCommentSource } from "./comments";

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

// Front matter is kept out of the editor and put back untouched on save.
export function splitFrontMatter(text: string): { front: string; body: string } {
  const m = text.match(FRONT_MATTER);
  if (!m) return { front: "", body: text };
  return { front: m[0].replace(/\s+$/, "") + "\n\n", body: text.slice(m[0].length).replace(/^\s+/, "") };
}

// Syntax the editor cannot write back faithfully. Files that use it open read-only.
export function unsupportedSyntax(body: string): string | null {
  let unsupported: string | null = null;
  // Tokenize instead of stripping HTML with a regex: code examples stay literal,
  // inline HTML is protected too, and malformed comments never become editable.
  const inspect = (token: import("marked").Token): void => {
    if (token.type === "html" && !isCommentSource(token.raw)) unsupported = "HTML";
    // Marked's custom-token walker doesn't visit a custom block's children.
    if (token.type === "footnoteDefinition") marked.walkTokens(token.tokens ?? [], inspect);
  };
  marked.walkTokens(marked.lexer(body), inspect);
  return unsupported;
}
