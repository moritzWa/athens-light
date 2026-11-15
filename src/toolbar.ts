import { getMarkRange, type Editor } from "@tiptap/core";
import { TextSelection, type SelectionBookmark } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { insertFootnote } from "./footnotes";
import { externalUrl } from "./link-ui";
import "./toolbar.css";

type Options = { comment: () => void; canComment: () => boolean; pickImage: () => Promise<string | null> };
const icons: Record<string, string> = {
  Bold: "<b>B</b>", Italic: "<i>I</i>", Strikethrough: "<s>S</s>", "Inline code": "&lt;/&gt;",
  Link: '<svg viewBox="0 0 20 20"><path d="m8 12 4-4M7 13l-1 1a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0m0 8a3 3 0 0 0 4 0l4-4a3 3 0 0 0-4-4l-1 1"/></svg>',
  Comment: '<svg viewBox="0 0 20 20"><path d="M4 3h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H8l-5 3V4a1 1 0 0 1 1-1Z"/><path d="M6 7h8M6 10h5"/></svg>',
  Footnote: "n<sup>1</sup>",
  Image: '<svg viewBox="0 0 20 20"><rect x="2" y="3" width="16" height="14" rx="2"/><circle cx="7" cy="7" r="1"/><path d="m3 15 5-5 3 3 3-4 4 6"/></svg>',
  Undo: '<svg viewBox="0 0 20 20"><path d="m7 4-4 4 4 4M3 8h9a4 4 0 0 1 0 8h-2"/></svg>',
  Redo: '<svg viewBox="0 0 20 20"><path d="m13 4 4 4-4 4m4-4H8a4 4 0 0 0 0 8h2"/></svg>',
};

export function mountToolbar(editor: Editor, options: Options) {
  const shell = document.createElement("div");
  shell.id = "editor-toolbar";
  const bar = document.createElement("div");
  bar.className = "toolbar-row";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Formatting and insert");
  shell.append(bar);
  document.getElementById("titlebar")!.after(shell);
  document.body.classList.add("has-toolbar");
  const panel = document.createElement("div");
  panel.className = "toolbar-panel";
  panel.hidden = true;
  document.body.append(panel);
  let bookmark: SelectionBookmark | null = null;
  let anchor: HTMLElement | null = null;
  let generation = 0;
  let frame = 0;
  const updates: (() => void)[] = [];

  // Native selectionchange can arrive after mouseup. Capture the visible range
  // before a fast toolbar click takes focus, rather than formatting an old caret.
  function captureSelection() {
    const selection = window.getSelection();
    if (!(editor.state.selection instanceof TextSelection) || !editor.isFocused || !selection?.anchorNode || !selection.focusNode) return;
    if (!editor.view.dom.contains(selection.anchorNode) || !editor.view.dom.contains(selection.focusNode)) return;
    const from = editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset);
    const to = editor.view.posAtDOM(selection.focusNode, selection.focusOffset);
    const current = TextSelection.between(editor.state.doc.resolve(from), editor.state.doc.resolve(to));
    if (!current.eq(editor.state.selection)) editor.view.dispatch(editor.state.tr.setSelection(current));
  }
  bar.addEventListener("mousedown", captureSelection, true);

  function close() {
    panel.hidden = true;
    anchor?.setAttribute("aria-expanded", "false");
    anchor = null;
    bookmark = null;
  }
  function restore() {
    if (bookmark) editor.view.dispatch(editor.state.tr.setSelection(bookmark.resolve(editor.state.doc)));
  }
  function apply(action: () => unknown) {
    if (!editor.isEditable) return;
    restore();
    close();
    editor.view.dispatch(closeHistory(editor.state.tr));
    action();
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.view.focus();
  }
  function button(label: string, action: () => void, available = () => true, active?: () => boolean) {
    const element = document.createElement("button");
    element.type = "button";
    element.title = label;
    element.setAttribute("aria-label", label);
    element.innerHTML = icons[label] ?? label;
    element.addEventListener("mousedown", event => event.preventDefault());
    element.addEventListener("click", action);
    updates.push(() => {
      element.disabled = !editor.isEditable || !available();
      if (active) element.setAttribute("aria-pressed", String(active()));
    });
    bar.append(element);
    return element;
  }
  function separator() {
    const element = document.createElement("span");
    element.className = "toolbar-separator";
    element.setAttribute("aria-hidden", "true");
    bar.append(element);
  }
  function position() {
    if (panel.hidden || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.top = `${rect.bottom + 7}px`;
    panel.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
  }
  function open(element: HTMLElement, label: string, role = "dialog") {
    if (anchor === element && !panel.hidden) { close(); return false; }
    close();
    bookmark = editor.state.selection.getBookmark();
    anchor = element;
    element.setAttribute("aria-expanded", "true");
    panel.setAttribute("role", role);
    panel.setAttribute("aria-label", label);
    panel.replaceChildren();
    panel.hidden = false;
    position();
    return true;
  }
  function field(form: HTMLFormElement, name: string, value: string, type = "text") {
    const label = document.createElement("label");
    label.textContent = name;
    const input = document.createElement("input");
    input.type = type;
    input.value = value;
    input.setAttribute("aria-label", name);
    label.append(input);
    form.append(label);
    return input;
  }
  function form(title: string, onSave: (error: HTMLElement) => void) {
    const element = document.createElement("form");
    const heading = document.createElement("strong");
    heading.textContent = title;
    const error = document.createElement("p");
    error.className = "toolbar-error";
    error.setAttribute("role", "status");
    const actions = document.createElement("div");
    actions.className = "toolbar-form-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Insert";
    actions.append(cancel, submit);
    element.append(heading);
    panel.append(element);
    element.addEventListener("submit", event => { event.preventDefault(); if (editor.isEditable) onSave(error); });
    return { element, submit, finish: () => element.append(error, actions) };
  }
  function menuItem(label: string, action: () => unknown, enabled = true) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = label;
    item.setAttribute("role", "menuitem");
    item.disabled = !enabled;
    item.addEventListener("mousedown", event => event.preventDefault());
    item.addEventListener("click", () => apply(action));
    panel.append(item);
    return item;
  }

  const style = document.createElement("select");
  style.setAttribute("aria-label", "Text style");
  for (const [value, label] of [["paragraph", "Text"], ["heading1", "Heading 1"], ["heading2", "Heading 2"], ["heading3", "Heading 3"], ["heading4", "Heading 4"], ["heading5", "Heading 5"], ["heading6", "Heading 6"], ["blockquote", "Quote"], ["codeBlock", "Code block"], ["divider", "Divider"], ["clear", "Clear formatting"]]) {
    const option = document.createElement("option");
    option.value = value!;
    option.textContent = label!;
    style.append(option);
  }
  style.addEventListener("mousedown", () => { close(); bookmark = editor.state.selection.getBookmark(); });
  style.addEventListener("change", () => {
    const value = style.value;
    apply(() => {
      if (value.startsWith("heading")) editor.commands.setHeading({ level: Number(value.slice(-1)) as 1 | 2 | 3 | 4 | 5 | 6 });
      else if (value === "blockquote") editor.commands.toggleBlockquote();
      else if (value === "codeBlock") editor.commands.toggleCodeBlock();
      else if (value === "divider") editor.commands.setHorizontalRule();
      else if (value === "clear") editor.chain().unsetAllMarks().clearNodes().run();
      else {
        if (editor.isActive("blockquote")) editor.commands.toggleBlockquote();
        editor.commands.setParagraph();
      }
    });
  });
  bar.append(style);
  updates.push(() => {
    style.disabled = !editor.isEditable;
    style.value = editor.isActive("heading") ? `heading${editor.getAttributes("heading").level}` : editor.isActive("codeBlock") ? "codeBlock" : editor.isActive("blockquote") ? "blockquote" : "paragraph";
  });
  separator();
  button("Bold", () => apply(() => editor.commands.toggleBold()), () => editor.can().toggleBold(), () => editor.isActive("bold"));
  button("Italic", () => apply(() => editor.commands.toggleItalic()), () => editor.can().toggleItalic(), () => editor.isActive("italic"));
  button("Strikethrough", () => apply(() => editor.commands.toggleStrike()), () => editor.can().toggleStrike(), () => editor.isActive("strike"));
  button("Inline code", () => apply(() => editor.commands.toggleCode()), () => editor.can().toggleCode(), () => editor.isActive("code"));
  const link = button("Link", () => {
    if (!open(link, "Insert link")) return;
    const selectedLink = () => {
      const selection = editor.state.selection;
      const range = getMarkRange(selection.$from, editor.schema.marks.link!);
      return range && selection.from >= range.from && selection.to <= range.to ? range : null;
    };
    const existing = selectedLink();
    const selection = existing ?? editor.state.selection;
    const text = editor.state.doc.textBetween(selection.from, selection.to, "");
    const fields = form("Link", error => {
      const raw = destination.value.trim();
      const safe = externalUrl(raw) ?? (!/^[a-z][a-z\d+.-]*:/i.test(raw) ? externalUrl(`https://${raw}`) : null);
      if (!safe) { error.textContent = "Enter an http, https or mailto URL."; return; }
      apply(() => {
        const current = selectedLink();
        if (text && label.value === text && (current || !editor.state.selection.empty)) {
          if (current) editor.commands.setTextSelection(current);
          editor.commands.setLink({ href: safe });
        } else {
          if (current) editor.commands.setTextSelection(current);
          else if (!text) editor.commands.setTextSelection(editor.state.selection.to);
          editor.commands.insertContent({ type: "text", text: label.value || safe, marks: [{ type: "link", attrs: { href: safe } }] });
        }
      });
    });
    const label = field(fields.element, "Link text", text);
    const destination = field(fields.element, "Link URL", editor.getAttributes("link").href ?? "");
    fields.finish();
    destination.focus();
  }, () => !editor.state.selection.$from.parent.type.spec.code, () => editor.isActive("link"));
  separator();
  const lists = button("Lists", () => {
    if (!open(lists, "Lists", "menu")) return;
    menuItem("Bullet list", () => editor.commands.toggleBulletList(), editor.can().toggleBulletList());
    menuItem("Numbered list", () => editor.commands.toggleOrderedList(), editor.can().toggleOrderedList());
    menuItem("Task list", () => editor.commands.toggleTaskList(), editor.can().toggleTaskList());
  }, () => !editor.state.selection.$from.parent.type.spec.code, () => editor.isActive("bulletList") || editor.isActive("orderedList") || editor.isActive("taskList"));
  separator();
  const comment = button("Comment", () => { close(); options.comment(); }, options.canComment);
  comment.id = "add-comment";
  const footnote = button("Footnote", () => apply(() => insertFootnote(editor)), () => !editor.state.selection.$to.parent.type.spec.code);
  footnote.id = "add-footnote";
  const image = button("Image", () => {
    if (!open(image, "Insert image")) return;
    const fields = form("Image", error => {
      const value = source.value.trim();
      if (!value || (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:\/\//i.test(value))) { error.textContent = "Enter an image URL or relative path, or choose a file."; return; }
      apply(() => { editor.commands.setTextSelection(editor.state.selection.to); editor.commands.setImage({ src: value, alt: alt.value }); });
    });
    const source = field(fields.element, "Image URL or path", "");
    const alt = field(fields.element, "Alternative text", "");
    const choose = document.createElement("button");
    choose.type = "button";
    choose.textContent = "Choose file…";
    choose.className = "toolbar-file-button";
    choose.addEventListener("click", async () => {
      const version = generation;
      choose.disabled = true;
      try {
        const selected = await options.pickImage();
        if (version !== generation || panel.hidden) return;
        if (selected) source.value = selected.split("/").map(encodeURIComponent).join("/");
      } catch { fields.element.querySelector<HTMLElement>("[role=status]")!.textContent = "Could not import this image."; }
      finally { choose.disabled = false; }
    });
    fields.element.append(choose);
    fields.finish();
    source.focus();
  }, () => !editor.state.selection.$from.parent.type.spec.code);
  const table = button("Table", () => {
    if (!open(table, editor.isActive("table") ? "Edit table" : "Insert table", editor.isActive("table") ? "menu" : "dialog")) return;
    if (editor.isActive("table")) {
      menuItem("Insert row above", () => editor.commands.addRowBefore(), editor.can().addRowBefore());
      menuItem("Insert row below", () => editor.commands.addRowAfter(), editor.can().addRowAfter());
      menuItem("Insert column left", () => editor.commands.addColumnBefore(), editor.can().addColumnBefore());
      menuItem("Insert column right", () => editor.commands.addColumnAfter(), editor.can().addColumnAfter());
      menuItem("Delete row", () => editor.commands.deleteRow(), editor.can().deleteRow());
      menuItem("Delete column", () => editor.commands.deleteColumn(), editor.can().deleteColumn());
      menuItem("Delete table", () => editor.commands.deleteTable(), editor.can().deleteTable());
      return;
    }
    const fields = form("Table", error => {
      const rowCount = Number(rows.value), columnCount = Number(columns.value);
      if (![rowCount, columnCount].every(value => Number.isInteger(value) && value >= 1 && value <= 20)) { error.textContent = "Choose between 1 and 20 rows and columns."; return; }
      apply(() => { editor.commands.setTextSelection(editor.state.selection.to); editor.commands.insertTable({ rows: rowCount, cols: columnCount, withHeaderRow: true }); });
    });
    const rows = field(fields.element, "Rows", "3", "number");
    const columns = field(fields.element, "Columns", "3", "number");
    for (const input of [rows, columns]) { input.min = "1"; input.max = "20"; }
    fields.finish();
    rows.focus();
  }, () => !editor.state.selection.$from.parent.type.spec.code, () => editor.isActive("table"));
  separator();
  button("Undo", () => apply(() => editor.commands.undo()), () => editor.can().undo());
  button("Redo", () => apply(() => editor.commands.redo()), () => editor.can().redo());

  function update() {
    frame = 0;
    updates.forEach(refresh => refresh());
    table.title = editor.isActive("table") ? "Edit table" : "Insert table";
  }
  const transaction = ({ transaction: tr }: { transaction: import("@tiptap/pm/state").Transaction }) => {
    if (tr.docChanged && tr.getMeta("preventUpdate")) { generation++; close(); }
    else if (bookmark && tr.docChanged) bookmark = bookmark.map(tr.mapping);
    if (!frame) frame = window.requestAnimationFrame(update);
  };
  const outside = (event: PointerEvent) => { if (!panel.contains(event.target as Node) && !shell.contains(event.target as Node)) close(); };
  editor.on("transaction", transaction);
  document.addEventListener("pointerdown", outside);
  window.addEventListener("resize", position);
  bar.addEventListener("scroll", position);
  update();
  return { destroy() {
    editor.off("transaction", transaction);
    document.removeEventListener("pointerdown", outside);
    window.removeEventListener("resize", position);
    bar.removeEventListener("mousedown", captureSelection, true);
    bar.removeEventListener("scroll", position);
    window.cancelAnimationFrame(frame);
    shell.remove(); panel.remove();
    document.body.classList.remove("has-toolbar");
  } };
}
