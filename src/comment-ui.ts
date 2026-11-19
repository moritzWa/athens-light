import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { commentId, commentText, validCommentText, commentAnchorRange, commentFocusKey, commentRanges, isRangeCloser, type CommentDraft, type CommentRange } from "./comments";
import "./comment-ui.css";

type Comment = { id: string; pos: number; text: string; quote?: string; node?: ProseMirrorNode; range?: CommentRange; anchor: Element | null };
type Card = { element: HTMLElement; jump: HTMLButtonElement; text: HTMLElement; form: HTMLFormElement; input: HTMLTextAreaElement; error: HTMLElement; submit: HTMLButtonElement; editing: boolean };

const ICONS = {
  edit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 3.5l2 2M3 13l.5-2.5 7-7 2 2-7 7L3 13z"/></svg>',
  remove: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8"/></svg>',
};

export function mountComments(editor: Editor) {
  const root = editor.options.element as HTMLElement;
  const layout = document.createElement("div");
  layout.id = "document-layout";
  root.before(layout);
  layout.append(root);
  const aside = document.createElement("aside");
  aside.id = "comments";
  aside.setAttribute("aria-label", "Document comments");
  layout.append(aside);

  let records: Comment[] = [];
  const cards = new Map<string, Card>();
  let active: string | null = null;
  let frame = 0;

  const draftOf = () => commentFocusKey.getState(editor.state)?.draft ?? null;
  const draftStart = (draft: CommentDraft) => "pos" in draft ? draft.pos : draft.from;

  function button(label: string, action: () => void) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.addEventListener("click", action);
    return element;
  }

  function iconButton(icon: string, label: string, className: string, action: () => void) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.innerHTML = icon;
    element.title = label;
    element.setAttribute("aria-label", label);
    element.addEventListener("click", event => { event.stopPropagation(); action(); });
    return element;
  }

  function anchorAt(pos: number, inline: boolean): Element | null {
    const range = commentAnchorRange(editor.state.doc, pos, inline);
    return range ? editor.view.nodeDOM(range.from) as Element | null : null;
  }

  function collect() {
    const doc = editor.state.doc;
    const comments: Comment[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name !== "htmlComment" && node.type.name !== "inlineHtmlComment") return;
      if (isRangeCloser(String(node.attrs.source))) return;
      comments.push({ id: node.attrs.id, pos, text: commentText(node.attrs.source), node, anchor: anchorAt(pos, node.isInline) });
    });
    for (const range of commentRanges(doc).values()) {
      comments.push({ id: range.id, pos: range.from, text: range.text, quote: doc.textBetween(range.from, range.to, " "), range, anchor: null });
    }
    return comments;
  }

  function topOf(item: { range?: { from: number }; anchor: Element | null }) {
    if (item.range) {
      try { return editor.view.coordsAtPos(item.range.from).top; } catch { return undefined; }
    }
    return item.anchor?.getBoundingClientRect().top;
  }

  function setActive(id: string | null) {
    active = id;
    if (commentFocusKey.getState(editor.state)?.id !== id) {
      editor.view.dispatch(editor.state.tr.setMeta(commentFocusKey, { id }));
    }
  }

  function activate(id: string, scroll = false) {
    setActive(id);
    const record = records.find(item => item.id === id);
    if (scroll) {
      const target = record?.range ? root.querySelector(`[data-comment-id="${id}"]`) : record?.anchor;
      target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    }
    schedule();
  }

  function cancel(id: string) {
    const card = cards.get(id);
    if (draftOf()?.id === id) editor.view.dispatch(editor.state.tr.setMeta(commentFocusKey, { draft: null }));
    else if (card) { card.editing = false; refresh(); }
  }

  // A mark cannot hold a blank line or, in a table, a newline or pipe, without breaking the Markdown around it.
  function rangeText(input: string, from: number) {
    const $pos = editor.state.doc.resolve(from);
    let inTable = false;
    for (let depth = $pos.depth; depth > 0; depth--) if ($pos.node(depth).type.name.startsWith("table")) inTable = true;
    const text = input.trim().replace(inTable ? /\s*\n\s*/g : /\n[ \t]*(?:\n[ \t]*)+/g, inTable ? " " : "\n");
    return inTable && text.includes("|") ? null : text;
  }

  function makeCard(id: string): Card {
    const element = document.createElement("article");
    element.className = "comment-card";
    element.dataset.commentId = id;
    const jump = button("", () => activate(id, true));
    jump.className = "comment-jump";
    jump.title = "Show commented text";
    jump.setAttribute("aria-label", "Show commented text");
    const tools = document.createElement("div");
    tools.className = "comment-tools";
    const edit = iconButton(ICONS.edit, "Edit", "comment-edit", () => editCard(id));
    const remove = iconButton(ICONS.remove, "Delete comment", "comment-delete", () => {
      const record = collect().find(item => item.id === id);
      if (!record || !editor.isEditable) return;
      const { tr } = editor.state;
      if (record.range) {
        editor.state.doc.nodesBetween(record.range.from, record.range.to, (node, pos) => {
          for (const mark of node.marks) if (mark.attrs.id === id) tr.removeMark(pos, pos + node.nodeSize, mark);
        });
      } else tr.delete(record.pos, record.pos + record.node!.nodeSize);
      editor.view.dispatch(tr);
    });
    tools.append(edit, remove);
    const text = document.createElement("p");
    text.className = "comment-text";
    const form = document.createElement("form");
    form.hidden = true;
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "Comment text");
    input.placeholder = "Comment";
    input.rows = 1;
    input.addEventListener("input", schedule);
    input.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(id); editor.view.focus(); }
      else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(); }
    });
    const error = document.createElement("p");
    error.className = "comment-error";
    error.setAttribute("role", "status");
    const actions = document.createElement("div");
    actions.className = "comment-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    const dismiss = button("Cancel", () => cancel(id));
    dismiss.className = "comment-cancel";
    actions.append(dismiss, submit);
    form.append(input, error, actions);
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!editor.isEditable) return;
      if (!validCommentText(input.value)) {
        error.textContent = "Write a comment without <!-- or -->.";
        schedule();
        return;
      }
      const draft = draftOf();
      const isDraft = draft?.id === id;
      const record = isDraft ? null : collect().find(item => item.id === id);
      if (!isDraft && !record) return;
      const { tr } = editor.state;
      const range = isDraft && draft && "from" in draft ? draft : record?.range;
      if (range) {
        const text = rangeText(input.value, range.from);
        if (text === null) {
          error.textContent = "Comments in a table can't contain |.";
          schedule();
          return;
        }
        const mark = editor.schema.marks.commentRange!.create({ id, text });
        if (record?.range) {
          editor.state.doc.nodesBetween(range.from, range.to, (node, pos) => {
            for (const old of node.marks) if (old.attrs.id === id) tr.removeMark(pos, pos + node.nodeSize, old);
          });
        }
        tr.addMark(range.from, range.to, mark);
        if (!commentRanges(tr.doc).has(id)) {
          error.textContent = "Inline code can't be commented. Select some regular text.";
          schedule();
          return;
        }
      } else if (isDraft && draft && "pos" in draft) {
        tr.insert(draft.pos, editor.schema.nodes.htmlComment!.create({ id, source: `<!-- ${input.value.trim()} -->` }));
      } else if (record?.node) {
        tr.setNodeMarkup(record.pos, undefined, { ...record.node.attrs, source: `<!-- ${input.value.trim()} -->` });
      }
      cards.get(id)!.editing = false;
      cards.get(id)!.element.classList.remove("comment-draft");
      if (isDraft) tr.setMeta(commentFocusKey, { draft: null, id });
      editor.view.dispatch(tr);
      activate(id);
    });
    element.append(jump, tools, text, form);
    element.addEventListener("click", () => activate(id));
    aside.append(element);
    return { element, jump, text, form, input, error, submit, editing: false };
  }

  function editCard(id: string) {
    if (!editor.isEditable) return;
    const record = records.find(item => item.id === id);
    const card = cards.get(id);
    if (!record || !card) return;
    card.input.value = record.text;
    card.error.textContent = "";
    card.editing = true;
    activate(id);
    refresh();
    card.input.focus();
  }

  function refresh() {
    records = collect();
    const draft = draftOf();
    const ids = new Set(records.map(item => item.id));
    if (draft) ids.add(draft.id);
    for (const [id, card] of cards) {
      if (!ids.has(id)) {
        card.element.remove();
        cards.delete(id);
      }
    }
    for (const record of records) {
      const card = cards.get(record.id) ?? makeCard(record.id);
      cards.set(record.id, card);
      card.text.textContent = record.text || "Empty comment";
      card.text.hidden = card.editing;
      card.form.hidden = !card.editing;
      card.jump.hidden = !record.quote;
      card.jump.textContent = record.quote ?? "";
      card.submit.textContent = "Save";
      aside.append(card.element);
    }
    if (draft) {
      const card = cards.get(draft.id) ?? makeCard(draft.id);
      cards.set(draft.id, card);
      card.editing = true;
      card.text.hidden = true;
      card.form.hidden = false;
      card.jump.hidden = !("from" in draft);
      card.jump.textContent = "from" in draft ? editor.state.doc.textBetween(draft.from, draft.to, " ") : "";
      card.submit.textContent = "Comment";
      card.element.classList.add("comment-draft");
      aside.append(card.element);
    }
    layout.classList.toggle("with-comments", ids.size > 0);
    aside.hidden = ids.size === 0;
    schedule();
  }

  function position() {
    frame = 0;
    const asideTop = aside.getBoundingClientRect().top;
    let bottom = 0;
    const draft = draftOf();
    const ordered = [...records.map(record => ({ id: record.id, pos: record.pos, top: topOf(record) })),
      ...(draft ? [{ id: draft.id, pos: draftStart(draft), top: "from" in draft ? topOf({ range: draft, anchor: null }) : topOf({ anchor: anchorAt(draft.pos, false) }) }] : [])];
    ordered.sort((a, b) => a.pos - b.pos);
    for (const item of ordered) {
      const card = cards.get(item.id);
      if (!card) continue;
      card.element.classList.toggle("is-active", item.id === active || item.id === draft?.id);
      const top = Math.max(bottom, (item.top ?? asideTop) - asideTop);
      card.element.style.top = `${top}px`;
      card.input.style.height = "auto";
      card.input.style.height = `${card.input.scrollHeight}px`;
      card.element.querySelectorAll<HTMLButtonElement>(".comment-edit, .comment-delete, button[type=submit]").forEach(element => element.disabled = !editor.isEditable);
      card.input.disabled = !editor.isEditable;
      bottom = top + card.element.getBoundingClientRect().height + 10;
    }
    aside.style.minHeight = `${bottom}px`;
  }

  function schedule() {
    if (!frame) frame = window.requestAnimationFrame(position);
  }

  function canAdd() {
    return editor.isEditable && !editor.state.selection.empty && editor.state.selection.$from.depth > 0 && !draftOf();
  }
  // Exact words in the first paragraph of the selection; the whole block only where text cannot carry a mark.
  function addComment() {
    if (!canAdd()) return;
    const { doc, selection } = editor.state;
    const { $from, $to } = selection;
    const id = commentId();
    let draft: CommentDraft;
    if ($from.parent.inlineContent && $from.parent.type.allowsMarkType(editor.schema.marks.commentRange!)) {
      let { from, to } = selection;
      // A note is paired comments inside one paragraph, so a longer selection keeps its first paragraph.
      if (!$from.sameParent($to)) to = $from.end();
      const text = doc.textBetween(from, to, "\n", "\n");
      to -= text.length - text.trimEnd().length;
      from += text.length - text.trimStart().length;
      if (from >= to) ({ from, to } = selection);
      // The file format nests comments, so a range that would cross another one grows to hold it.
      for (let changed = true; changed;) {
        changed = false;
        for (const other of commentRanges(doc).values()) {
          if (other.from < from && other.to > from && other.to < to) { from = other.from; changed = true; }
          if (other.from > from && other.from < to && other.to > to) { to = other.to; changed = true; }
        }
      }
      draft = { id, from, to };
    } else draft = { id, pos: $from.after(1) };
    active = id;
    editor.view.dispatch(editor.state.tr.setMeta(commentFocusKey, { id, draft }));
    cards.get(id)?.input.focus();
  }

  const transaction = ({ transaction: tr }: { transaction: Transaction }) => {
    if (tr.docChanged || tr.getMeta(commentFocusKey)?.draft !== undefined) refresh();
    else schedule();
  };
  const clickAnchor = (event: MouseEvent) => {
    const target = event.target as Element;
    const range = target.closest?.("[data-comment-id]");
    const record = range ? records.find(item => item.id === range.getAttribute("data-comment-id")) : records.find(item => item.anchor?.contains(target));
    if (record) activate(record.id);
  };
  root.addEventListener("click", clickAnchor);
  editor.on("transaction", transaction);
  editor.on("focus", schedule);
  editor.on("blur", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, { passive: true });
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  observer?.observe(root);
  refresh();

  return {
    canAdd,
    add: addComment,
    destroy() {
      editor.off("transaction", transaction);
      editor.off("focus", schedule);
      editor.off("blur", schedule);
      root.removeEventListener("click", clickAnchor);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule);
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      layout.before(root);
      layout.remove();
    },
  };
}
