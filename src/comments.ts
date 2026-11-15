import { Extension, Node } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

let nextId = 0;
export const commentId = () => `comment-${++nextId}`;
export const isCommentSource = (source: string) => /^(?:\s*<!--[\s\S]*?-->)+\s*$/.test(source);
export const commentText = (source: string) => source.replace(/^\s*<!--/, "").replace(/-->\s*$/, "").trim();
export const validCommentText = (text: string) => !!text.trim() && !/<!--|-->/.test(text);

export function commentAnchorRange(doc: ProseMirrorNode, pos: number, inline: boolean) {
  const resolved = doc.resolve(pos);
  if (inline) return { from: resolved.before(), to: resolved.after() };
  let before: { from: number; to: number } | null = null;
  let after: { from: number; to: number } | null = null;
  resolved.parent.forEach((node, offset) => {
    if (node.type.name === "htmlComment") return;
    const from = resolved.start() + offset;
    if (offset < resolved.parentOffset) before = { from, to: from + node.nodeSize };
    else after ??= { from, to: from + node.nodeSize };
  });
  return before ?? after;
}

export const commentFocusKey = new PluginKey<string | null>("commentFocus");
export const CommentFocus = Extension.create({
  name: "commentFocus",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: commentFocusKey,
      state: {
        init: () => null,
        apply: (tr, previous) => tr.getMeta(commentFocusKey)?.id ?? previous,
      },
      props: {
        decorations(state) {
          const id = commentFocusKey.getState(state);
          const decorations: Decoration[] = [];
          if (id) state.doc.descendants((node, pos) => {
            if (node.attrs.id !== id) return;
            const range = commentAnchorRange(state.doc, pos, node.isInline);
            if (range) decorations.push(Decoration.node(range.from, range.to, { class: "comment-anchor-active" }));
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});

const attributes = () => ({
  source: { default: "", rendered: false },
  id: { default: null, rendered: false },
});

// Comments carry their original source, not HTML that the browser could execute.
// The margin UI reads these nodes; they occupy no space in the prose itself.
export const HtmlComment = Node.create({
  name: "htmlComment",
  group: "block",
  atom: true,
  selectable: false,
  addAttributes: attributes,
  parseHTML: () => [{ tag: "div[data-html-comment]", getAttrs: element => ({ source: element.getAttribute("data-source"), id: commentId() }) }],
  renderHTML: ({ node }) => ["div", { "data-html-comment": "", "data-source": node.attrs.source, hidden: "", style: "display: none", "aria-hidden": "true" }],
  markdownTokenName: "html",
  parseMarkdown: token => {
    const source = token.raw ?? "";
    if (!token.block || !isCommentSource(source)) return [];
    // Marked can put consecutive comments into one HTML token.
    return [...source.matchAll(/<!--[\s\S]*?-->/g)].map(match => ({
      type: "htmlComment", attrs: { source: match[0], id: commentId() },
    }));
  },
  renderMarkdown: node => node.attrs?.source ?? "",
});

export const InlineHtmlComment = HtmlComment.extend({
  name: "inlineHtmlComment",
  group: "inline",
  inline: true,
  parseHTML: () => [{ tag: "span[data-html-comment]", getAttrs: element => ({ source: element.getAttribute("data-source"), id: commentId() }) }],
  renderHTML: ({ node }) => ["span", { "data-html-comment": "", "data-source": node.attrs.source, hidden: "", style: "display: none", "aria-hidden": "true" }],
  markdownTokenName: "inlineHtmlComment",
  // Tiptap's built-in inline HTML path skips custom HTML handlers, so recognize
  // comments before that fallback. Code spans and fenced code stay literal.
  markdownTokenizer: {
    name: "inlineHtmlComment",
    level: "inline",
    start: source => source.indexOf("<!--"),
    tokenize: source => {
      const match = source.match(/^<!--[\s\S]*?-->/);
      if (match) return { type: "inlineHtmlComment", raw: match[0] };
    },
  },
  parseMarkdown: token => ({ type: "inlineHtmlComment", attrs: { source: token.raw, id: commentId() } }),
});

// Normalize editor-generated empty paragraphs without rewriting comment bodies.
export function normalizeMarkdown(source: string): string {
  return source.split(/(<!--[\s\S]*?-->)/g).map((part, index) => index % 2 ? part : part
    .replace(/^&nbsp;$/gm, "")
    .replace(/\n{3,}/g, "\n\n"))
    .join("").replace(/\s+$/, "") + "\n";
}
