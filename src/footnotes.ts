import { Node, type Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import "./footnotes.css";
import { footnoteNumbers as numbers, footnoteKey as key, renderFootnote } from "./footnote-order";

function jump(editor: Editor, label: string, type: string) {
  let target: number | undefined;
  editor.state.doc.descendants((node, pos) => {
    if (target === undefined && node.type.name === type && key(node.attrs.label) === key(label)) target = pos;
  });
  if (target === undefined) return;
  const pos = type === "footnoteDefinition" ? target + 1 : target;
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos))).scrollIntoView());
  (editor.view.nodeDOM(target) as HTMLElement | null)?.scrollIntoView?.({ block: "center" });
  editor.view.focus();
}

export const FootnoteReference = Node.create({
  name: "footnoteReference",
  inline: true,
  group: "inline",
  atom: true,
  addAttributes: () => ({ label: { default: "1" }, definition: { default: null, rendered: false } }),
  parseHTML: () => [{ tag: "sup[data-footnote-reference]", getAttrs: el => {
    const label = el.getAttribute("data-label");
    if (!label || /[\s\]]/.test(label)) return false;
    let definition = null;
    try { definition = JSON.parse(el.getAttribute("data-definition") ?? "null"); } catch { /* Plain references have no clipboard payload. */ }
    return { label, definition };
  } }],
  renderHTML: ({ node }) => ["sup", { "data-footnote-reference": "", "data-label": node.attrs.label, "data-definition": node.attrs.definition ? JSON.stringify(node.attrs.definition) : undefined }, node.attrs.label],
  markdownTokenizer: {
    name: "footnoteReference",
    level: "inline",
    start: source => source.indexOf("[^"),
    tokenize: source => {
      const match = source.match(/^\[\^([^\]\s]+)\]/);
      if (match) return { type: "footnoteReference", raw: match[0], label: match[1] };
    },
  },
  parseMarkdown: token => ({ type: "footnoteReference", attrs: { label: token.label } }),
  renderMarkdown: node => `[^${node.attrs?.label}]`,
  addNodeView() {
    return ({ node, editor }) => {
      const dom = document.createElement("sup");
      dom.dataset.footnoteReference = "";
      dom.dataset.label = node.attrs.label;
      const button = document.createElement("button");
      button.type = "button";
      dom.append(button);
      const update = () => {
        const number = numbers(editor.state.doc).get(key(node.attrs.label));
        button.textContent = String(number ?? node.attrs.label);
        let text = "Missing footnote definition";
        editor.state.doc.descendants(candidate => {
          if (candidate.type.name === "footnoteDefinition" && key(candidate.attrs.label) === key(node.attrs.label) && text === "Missing footnote definition") text = candidate.textContent;
        });
        button.title = text;
        button.setAttribute("aria-label", `Footnote ${number}: ${text}`);
      };
      button.addEventListener("click", () => jump(editor, node.attrs.label, "footnoteDefinition"));
      editor.on("transaction", update);
      update();
      return { dom, ignoreMutation: () => true, stopEvent: () => true, destroy: () => editor.off("transaction", update) };
    };
  },
});

export const FootnoteDefinition = Node.create({
  name: "footnoteDefinition",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,
  addAttributes: () => ({ label: { default: "1" } }),
  parseHTML: () => [{ tag: "section[data-footnote-definition]", getAttrs: el => {
    const label = el.getAttribute("data-label");
    return label && !/[\s\]]/.test(label) ? { label } : false;
  } }],
  renderHTML: ({ node }) => ["section", { "data-footnote-definition": "", "data-label": node.attrs.label }, 0],
  markdownTokenizer: {
    name: "footnoteDefinition",
    level: "block",
    start: source => source.search(/^ {0,3}\[\^[^\]\s]+\]:/m),
    tokenize: (source, _tokens, lexer) => {
      const first = source.match(/^ {0,3}\[\^([^\]\s]+)\]:[ \t]*([^\n]*)(?:\n|$)/);
      if (!first) return;
      let raw = first[0];
      let body = first[2] + "\n";
      let indent: number | undefined;
      while (raw.length < source.length) {
        const rest = source.slice(raw.length);
        const continued = rest.match(/^((?: {2,}|\t))([^\n]*)(?:\n|$)/);
        if (continued) {
          // GitHub accepts two-space continuations; four spaces and tabs are
          // also common. Keep deeper indentation for nested lists/code.
          const prefix = continued[1]!;
          indent ??= prefix.length >= 4 ? 4 : 2;
          raw += continued[0];
          body += (prefix === "\t" ? "" : prefix.slice(Math.min(indent, prefix.length))) + continued[2] + "\n";
          continue;
        }
        const blank = rest.match(/^(?:[ \t]*\n)+(?=(?: {2}|\t))/);
        if (blank) { raw += blank[0]; body += blank[0]; continue; }
        break;
      }
      return { type: "footnoteDefinition", raw, label: first[1], tokens: lexer.blockTokens(body) };
    },
  },
  parseMarkdown: (token, helpers) => {
    const content = helpers.parseChildren(token.tokens ?? []);
    return { type: "footnoteDefinition", attrs: { label: token.label }, content: content.length ? content : [{ type: "paragraph" }] };
  },
  renderMarkdown: renderFootnote,
  addNodeView() {
    return ({ node, editor }) => {
      const dom = document.createElement("section");
      dom.dataset.footnoteDefinition = "";
      dom.dataset.label = node.attrs.label;
      const label = document.createElement("button");
      label.type = "button";
      label.contentEditable = "false";
      label.className = "footnote-number";
      label.title = `Back to reference (${node.attrs.label})`;
      const contentDOM = document.createElement("div");
      contentDOM.className = "footnote-content";
      dom.append(label, contentDOM);
      label.addEventListener("click", () => jump(editor, node.attrs.label, "footnoteReference"));
      const update = () => { label.textContent = String(numbers(editor.state.doc).get(key(node.attrs.label)) ?? node.attrs.label); };
      editor.on("transaction", update);
      update();
      return {
        dom, contentDOM,
        ignoreMutation: mutation => mutation.type !== "selection" && !contentDOM.contains(mutation.target),
        stopEvent: event => label.contains(event.target as globalThis.Node),
        destroy: () => editor.off("transaction", update),
      };
    };
  },
});

export function insertFootnote(editor: Editor) {
  const end = editor.state.selection.$to;
  const insertion = end.parent.inlineContent ? end.pos : TextSelection.near(end, -1).to;
  if (!editor.isEditable || editor.state.doc.resolve(insertion).parent.type.spec.code) return;
  const used = new Set<string>();
  editor.state.doc.descendants(node => { if (["footnoteReference", "footnoteDefinition", "unusedFootnote"].includes(node.type.name)) used.add(key(node.attrs.label)); });
  let label = 1;
  while (used.has(String(label))) label++;
  const attrs = { label: String(label) };
  const tr = editor.state.tr.insert(insertion, editor.schema.nodes.footnoteReference!.create(attrs));
  const pos = tr.doc.content.size;
  tr.insert(pos, editor.schema.nodes.footnoteDefinition!.create(attrs, editor.schema.nodes.paragraph!.create()));
  tr.setSelection(TextSelection.create(tr.doc, pos + 2));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}
