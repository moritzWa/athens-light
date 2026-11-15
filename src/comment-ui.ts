import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { commentId, commentText, validCommentText, commentAnchorRange, commentFocusKey } from "./comments";
import "./comment-ui.css";
import { insertFootnote } from "./footnotes";

type Comment = { id: string; pos: number; node: ProseMirrorNode; anchor: Element | null };
type Card = { element: HTMLElement; text: HTMLElement; form: HTMLFormElement; input: HTMLTextAreaElement; error: HTMLElement; editing: boolean };

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
  const add = document.createElement("button");
  add.id = "add-comment";
  add.type = "button";
  add.textContent = "+ Comment";
  add.title = "Comment on this paragraph";
  add.hidden = true;
  const actions = document.createElement("div");
  actions.id = "selection-actions";
  actions.hidden = true;
  const footnote = document.createElement("button");
  footnote.id = "add-footnote";
  footnote.type = "button";
  footnote.textContent = "+ Footnote";
  footnote.addEventListener("mousedown", event => event.preventDefault());
  footnote.addEventListener("click", () => insertFootnote(editor));
  actions.append(add, footnote);
  root.append(actions);

  let records: Comment[] = [];
  const cards = new Map<string, Card>();
  let active: string | null = null;
  let draft: { id: string; pos: number; anchor: Element | null } | null = null;
  let frame = 0;

  function button(label: string, action: () => void) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.addEventListener("click", action);
    return element;
  }

  function anchorAt(pos: number, inline: boolean): Element | null {
    const range = commentAnchorRange(editor.state.doc, pos, inline);
    return range ? editor.view.nodeDOM(range.from) as Element | null : null;
  }

  function collect() {
    const comments: Comment[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== "htmlComment" && node.type.name !== "inlineHtmlComment") return;
      comments.push({ id: node.attrs.id, pos, node, anchor: anchorAt(pos, node.isInline) });
    });
    return comments;
  }

  function activate(id: string, scroll = false) {
    active = id;
    if (commentFocusKey.getState(editor.state) !== id) {
      editor.view.dispatch(editor.state.tr.setMeta(commentFocusKey, { id }));
    }
    const record = records.find(item => item.id === id);
    if (scroll) record?.anchor?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    schedule();
  }

  function makeCard(id: string): Card {
    const element = document.createElement("article");
    element.className = "comment-card";
    element.dataset.commentId = id;
    const header = document.createElement("div");
    header.className = "comment-header";
    const jump = button("Comment", () => activate(id, true));
    jump.className = "comment-jump";
    jump.title = "Show commented paragraph";
    jump.setAttribute("aria-label", "Show commented paragraph");
    const edit = button("Edit", () => editCard(id));
    edit.className = "comment-edit";
    const remove = button("Delete", () => {
      const record = collect().find(item => item.id === id);
      if (!record || !editor.isEditable) return;
      editor.view.dispatch(editor.state.tr.delete(record.pos, record.pos + record.node.nodeSize));
    });
    remove.setAttribute("aria-label", "Delete comment");
    remove.className = "comment-delete";
    header.append(jump, edit, remove);
    const text = document.createElement("p");
    text.className = "comment-text";
    const form = document.createElement("form");
    form.hidden = true;
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "Comment text");
    input.placeholder = "Write a comment…";
    input.rows = 3;
    input.addEventListener("input", schedule);
    const error = document.createElement("p");
    error.className = "comment-error";
    error.setAttribute("role", "status");
    const actions = document.createElement("div");
    actions.className = "comment-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Save";
    const cancel = button("Cancel", () => {
      if (draft?.id === id) draft = null;
      else cards.get(id)!.editing = false;
      refresh();
    });
    actions.append(cancel, submit);
    form.append(input, error, actions);
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!editor.isEditable) return;
      if (!validCommentText(input.value)) {
        error.textContent = "Write a comment without <!-- or -->.";
        schedule();
        return;
      }
      const source = `<!-- ${input.value.trim()} -->`;
      cards.get(id)!.editing = false;
      cards.get(id)!.element.classList.remove("comment-draft");
      if (draft?.id === id) {
        const pos = draft.pos;
        draft = null;
        editor.view.dispatch(editor.state.tr.insert(pos, editor.schema.nodes.htmlComment!.create({ id, source })));
      } else {
        const record = collect().find(item => item.id === id);
        if (!record) return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(record.pos, undefined, { ...record.node.attrs, source }));
      }
      activate(id);
    });
    element.append(header, text, form);
    element.addEventListener("click", () => activate(id));
    aside.append(element);
    return { element, text, form, input, error, editing: false };
  }

  function editCard(id: string) {
    if (!editor.isEditable) return;
    const record = records.find(item => item.id === id);
    const card = cards.get(id);
    if (!record || !card) return;
    card.input.value = commentText(record.node.attrs.source);
    card.error.textContent = "";
    card.editing = true;
    activate(id);
    refresh();
    card.input.focus();
  }

  function refresh() {
    records = collect();
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
      card.text.textContent = commentText(record.node.attrs.source) || "Empty comment";
      card.text.hidden = card.editing;
      card.form.hidden = !card.editing;
      aside.append(card.element);
    }
    if (draft) {
      const card = cards.get(draft.id) ?? makeCard(draft.id);
      cards.set(draft.id, card);
      card.editing = true;
      card.text.hidden = true;
      card.form.hidden = false;
      card.element.classList.add("comment-draft");
    }
    layout.classList.toggle("with-comments", ids.size > 0);
    aside.hidden = ids.size === 0;
    schedule();
  }

  function position() {
    frame = 0;
    const asideTop = aside.getBoundingClientRect().top;
    let bottom = 0;
    const ordered = [...records.map(record => ({ ...record, card: cards.get(record.id)! })),
      ...(draft ? [{ ...draft, card: cards.get(draft.id)! }] : [])];
    ordered.sort((a, b) => a.pos - b.pos);
    for (const item of ordered) {
      const { card } = item;
      card.element.classList.toggle("is-active", item.id === active);
      const top = Math.max(bottom, (item.anchor?.getBoundingClientRect().top ?? asideTop) - asideTop);
      card.element.style.top = `${top}px`;
      card.input.style.height = "auto";
      card.input.style.height = `${Math.max(76, card.input.scrollHeight)}px`;
      card.element.querySelectorAll<HTMLButtonElement>(".comment-edit, .comment-delete, button[type=submit]").forEach(element => element.disabled = !editor.isEditable);
      card.input.disabled = !editor.isEditable;
      bottom = top + card.element.getBoundingClientRect().height + 12;
    }
    aside.style.minHeight = `${bottom}px`;
    const { $from } = editor.state.selection;
    const showAdd = editor.isEditable && !editor.state.selection.empty && (editor.isFocused || actions.contains(document.activeElement)) && $from.depth > 0 && !draft;
    add.hidden = !showAdd;
    actions.hidden = !showAdd;
    footnote.disabled = !!editor.state.selection.$to.parent.type.spec.code;
    if (showAdd) {
      const paragraph = editor.view.nodeDOM($from.before(1)) as HTMLElement | null;
      const rect = paragraph?.getBoundingClientRect();
      const right = root.getBoundingClientRect().right;
      actions.style.top = `${Math.max(78, Math.min(window.innerHeight - 36, rect?.top ?? 64))}px`;
      actions.style.left = `${Math.max(8, Math.min(window.innerWidth - 200, right - 192))}px`;
    }
  }

  function schedule() {
    if (!frame) frame = window.requestAnimationFrame(position);
  }

  add.addEventListener("mousedown", event => event.preventDefault());
  add.addEventListener("click", () => {
    if (!editor.isEditable || draft) return;
    const { $from } = editor.state.selection;
    if (!$from.depth) return;
    const id = commentId();
    draft = { id, pos: $from.after(1), anchor: editor.view.nodeDOM($from.before(1)) as Element | null };
    active = id;
    refresh();
    cards.get(id)!.input.focus();
  });

  const transaction = ({ transaction: tr }: { transaction: import("@tiptap/pm/state").Transaction }) => {
    if (draft && tr.docChanged) {
      draft.pos = tr.mapping.map(draft.pos);
      draft.anchor = anchorAt(draft.pos, false);
    }
    if (tr.docChanged) refresh();
    else schedule();
  };
  const clickAnchor = (event: MouseEvent) => {
    const record = records.find(item => item.anchor?.contains(event.target as globalThis.Node));
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
      actions.remove();
    },
  };
}
