import { Extension, Mark, Node } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
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

// A comment on exact words. In the Markdown file it is a pair of HTML comments around
// the text, so other editors show the text and hide the note. In the editor it is a mark,
// so typing, deleting and selecting behave like any other formatting.
const RANGE_OPEN = /^<!--\s*comment:\s*([\s\S]*?)\s*-->$/;
const RANGE_CLOSE = /^<!--\s*\/comment\s*-->$/;
export const rangeOpener = (text: string) => `<!-- comment: ${text} -->`;
export const RANGE_CLOSER = "<!-- /comment -->";
export const isRangeCloser = (source: string) => RANGE_CLOSE.test(source);

export type CommentRange = { id: string; text: string; from: number; to: number };

export function commentRanges(doc: ProseMirrorNode) {
  const ranges = new Map<string, CommentRange>();
  doc.descendants((node, pos) => {
    for (const mark of node.marks) {
      if (mark.type.name !== "commentRange") continue;
      const range = ranges.get(mark.attrs.id);
      if (range) { range.from = Math.min(range.from, pos); range.to = Math.max(range.to, pos + node.nodeSize); }
      else ranges.set(mark.attrs.id, { id: mark.attrs.id, text: mark.attrs.text, from: pos, to: pos + node.nodeSize });
    }
  });
  return ranges;
}

export type CommentDraft = { id: string; from: number; to: number } | { id: string; pos: number };
export type CommentFocusState = { id: string | null; draft: CommentDraft | null };
export const commentFocusKey = new PluginKey<CommentFocusState>("commentFocus");
export const CommentFocus = Extension.create({
  name: "commentFocus",
  addProseMirrorPlugins() {
    return [new Plugin<CommentFocusState>({
      key: commentFocusKey,
      state: {
        init: () => ({ id: null, draft: null }),
        apply(tr, previous) {
          let next = previous;
          if (tr.docChanged && next.draft) {
            const { draft } = next;
            next = { ...next, draft: "pos" in draft
              ? { ...draft, pos: tr.mapping.map(draft.pos) }
              : { ...draft, from: tr.mapping.map(draft.from, 1), to: tr.mapping.map(draft.to, -1) } };
          }
          const meta: Partial<CommentFocusState> | undefined = tr.getMeta(commentFocusKey);
          return meta ? { ...next, ...meta } : next;
        },
      },
      props: {
        decorations(state) {
          const { id, draft } = commentFocusKey.getState(state)!;
          const decorations: Decoration[] = [];
          const size = state.doc.content.size;
          if (id) {
            const range = commentRanges(state.doc).get(id);
            if (range) decorations.push(Decoration.inline(range.from, range.to, { class: "comment-range-active" }));
            else state.doc.descendants((node, pos) => {
              if (node.attrs.id !== id) return;
              const anchor = commentAnchorRange(state.doc, pos, node.isInline);
              if (anchor) decorations.push(Decoration.node(anchor.from, anchor.to, { class: "comment-anchor-active" }));
            });
          }
          if (draft && "pos" in draft && draft.pos <= size) {
            const anchor = commentAnchorRange(state.doc, draft.pos, false);
            if (anchor) decorations.push(Decoration.node(anchor.from, anchor.to, { class: "comment-anchor-active" }));
          } else if (draft && "from" in draft && draft.from < draft.to && draft.to <= size) {
            decorations.push(Decoration.inline(draft.from, draft.to, { class: "comment-range comment-range-active" }));
          }
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});

export const CommentRangeMark = Mark.create({
  name: "commentRange",
  inclusive: false,
  excludes: "",
  addAttributes: () => ({ id: { default: null, rendered: false }, text: { default: "", rendered: false } }),
  parseHTML: () => [{ tag: "span[data-comment-id]", getAttrs: element => ({ id: commentId(), text: element.getAttribute("data-comment") ?? "" }) }],
  renderHTML: ({ mark }) => ["span", { class: "comment-range", "data-comment-id": mark.attrs.id, "data-comment": mark.attrs.text }, 0],
  // A paragraph that opens with a comment is an HTML block to Markdown, so the words
  // after it would be raw HTML. When a closing comment follows, it is a paragraph.
  markdownTokenizer: {
    name: "commentParagraph",
    level: "block",
    // Marked passes the text after its first character, so a line start must be a real newline.
    start: source => { const newline = source.search(/\n {0,3}<!--\s*comment:/); return newline < 0 ? -1 : newline + 1; },
    tokenize: (source, _tokens, helpers) => {
      const opener = source.match(/^ {0,3}<!--\s*comment:(?:(?!\n[ \t]*\n)[\s\S])*?-->/);
      if (!opener) return;
      const lineEnd = source.indexOf("\n", opener[0].length);
      let raw = lineEnd < 0 ? source : source.slice(0, lineEnd + 1);
      while (raw.length < source.length) {
        const line = source.slice(raw.length).match(/^[^\n]*(?:\n|$)/)![0];
        if (!line.trim() || !helpers.isParagraphContinuation?.(line.replace(/\n$/, ""))) break;
        raw += line;
      }
      if (!/<!--\s*\/comment\s*-->/.test(raw)) return;
      const text = raw.replace(/\n$/, "").replace(/^ {0,3}/, "");
      return { type: "paragraph", raw, text, tokens: helpers.inlineTokens(text) };
    },
  },
});

type Json = { type?: string; text?: string; attrs?: Record<string, any>; marks?: Json[]; content?: Json[] };
const isRangeMark = (mark: Json) => mark.type === "commentRange";
const marker = (source: string): Json => ({ type: "inlineHtmlComment", attrs: { source, id: commentId() } });

// The file holds paired HTML comments, the editor holds a mark: convert at the Markdown boundary.
export function commentsToMarkers(node: Json): Json {
  if (!node.content) return node;
  const kids = node.content.map(commentsToMarkers);
  const idsOf = (kid: Json) => (kid.marks ?? []).filter(isRangeMark).map(mark => mark.attrs!.id as string);
  if (!kids.some(kid => idsOf(kid).length)) return { ...node, content: kids };
  const text = new Map<string, string>();
  const last = new Map<string, number>();
  kids.forEach((kid, index) => (kid.marks ?? []).filter(isRangeMark).forEach(mark => { text.set(mark.attrs!.id, mark.attrs!.text); last.set(mark.attrs!.id, index); }));
  const out: Json[] = [];
  const stack: string[] = [];
  const open = (id: string) => { out.push(marker(rangeOpener(text.get(id)!))); stack.push(id); };
  kids.forEach((kid, index) => {
    const ids = new Set(idsOf(kid));
    const cut = stack.findIndex(id => !ids.has(id));
    if (cut >= 0) {
      const reopen = stack.slice(cut).filter(id => ids.has(id));
      for (let i = stack.length; i > cut; i--) out.push(marker(RANGE_CLOSER));
      stack.length = cut;
      reopen.forEach(open);
    }
    // Ranges that end last go outermost, so the pairs nest.
    [...ids].filter(id => !stack.includes(id)).sort((a, b) => last.get(b)! - last.get(a)!).forEach(open);
    const marks = (kid.marks ?? []).filter(mark => !isRangeMark(mark));
    const { marks: _marks, ...rest } = kid;
    out.push(marks.length ? { ...rest, marks } : rest);
  });
  stack.forEach(() => out.push(marker(RANGE_CLOSER)));
  return { ...node, content: out };
}

export function markersToComments(node: Json): Json {
  if (!node.content) return node;
  const kids = node.content.map(markersToComments);
  const source = (kid: Json) => kid.type === "inlineHtmlComment" ? String(kid.attrs?.source ?? "") : "";
  const pairs: { open: number; close: number; id: string; text: string }[] = [];
  const stack: number[] = [];
  kids.forEach((kid, index) => {
    if (RANGE_OPEN.test(source(kid))) stack.push(index);
    else if (RANGE_CLOSE.test(source(kid))) {
      const open = stack.pop();
      if (open !== undefined && index - open > 1) pairs.push({ open, close: index, id: commentId(), text: RANGE_OPEN.exec(source(kids[open]!))![1]! });
    }
  });
  if (!pairs.length) return { ...node, content: kids };
  const active: typeof pairs = [];
  const out: Json[] = [];
  kids.forEach((kid, index) => {
    const opening = pairs.find(pair => pair.open === index);
    if (opening) return void active.push(opening);
    const closing = pairs.find(pair => pair.close === index);
    if (closing) return void active.splice(active.indexOf(closing), 1);
    out.push(active.length ? { ...kid, marks: [...(kid.marks ?? []), ...active.map(pair => ({ type: "commentRange", attrs: { id: pair.id, text: pair.text } }))] } : kid);
  });
  return { ...node, content: out };
}

export const CommentMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    this.parent?.(event);
    const manager = this.editor.markdown;
    if (!manager) return;
    const parse = manager.parse.bind(manager);
    const serialize = manager.serialize.bind(manager);
    manager.parse = markdown => markersToComments(parse(markdown) as Json) as ReturnType<typeof parse>;
    manager.serialize = doc => serialize(typeof doc === "object" ? commentsToMarkers(doc as Json) as typeof doc : doc);
    const content = this.editor.options.content;
    if (content && typeof content === "object") this.editor.options.content = markersToComments(content as Json) as typeof content;
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
