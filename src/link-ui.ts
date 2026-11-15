import { getMarkRange, type Editor } from "@tiptap/core";
import "./link-ui.css";

export function externalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export async function copyLink(value: string) {
  try {
    if (navigator.clipboard) { await navigator.clipboard.writeText(value); return; }
  } catch { /* WKWebView can require the synchronous clipboard fallback. */ }
  const focused = document.activeElement as HTMLElement | null;
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const input = document.createElement("textarea");
  input.value = value;
  input.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.append(input);
  input.focus();
  input.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
  } finally {
    input.remove();
    focused?.focus();
    if (range && selection) { selection.removeAllRanges(); selection.addRange(range); }
  }
}

export function mountLinks(editor: Editor, openUrl: (url: string) => Promise<unknown>) {
  const root = editor.view.dom;
  const popover = document.createElement("div");
  popover.className = "link-popover";
  popover.hidden = true;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Link");
  const preview = document.createElement("div");
  preview.className = "link-preview";
  const destination = document.createElement("button");
  destination.type = "button";
  destination.className = "link-destination";
  const icon = document.createElement("span");
  icon.textContent = "↗";
  icon.setAttribute("aria-hidden", "true");
  const urlText = document.createElement("span");
  destination.append(icon, urlText);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "link-copy";
  copy.setAttribute("aria-label", "Copy link");
  copy.innerHTML = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="7" y="6" width="10" height="12" rx="2"/><path d="M13 6V4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/></svg>';
  const edit = document.createElement("button");
  edit.type = "button";
  edit.textContent = "Edit";
  preview.append(destination, copy, edit);
  const form = document.createElement("form");
  form.hidden = true;
  const label = document.createElement("input");
  label.setAttribute("aria-label", "Link text");
  label.placeholder = "Text";
  const url = document.createElement("input");
  url.setAttribute("aria-label", "Link URL");
  url.placeholder = "https://example.com";
  url.type = "text";
  url.spellcheck = false;
  const error = document.createElement("p");
  error.className = "link-error";
  error.setAttribute("role", "status");
  const status = document.createElement("p");
  status.className = "link-error";
  status.setAttribute("role", "status");
  const actions = document.createElement("div");
  actions.className = "link-actions";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove link";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save";
  actions.append(remove, cancel, save);
  form.append(label, url, error, actions);
  popover.append(preview, form, status);
  document.body.append(popover);
  let anchor: HTMLAnchorElement | null = null;
  let range: { from: number; to: number } | null = null;
  let closeTimer: number | undefined;
  let destroyed = false;

  function hide() {
    window.clearTimeout(closeTimer);
    popover.hidden = true;
    anchor = null;
    range = null;
    form.hidden = true;
    preview.hidden = false;
  }
  function position() {
    if (!anchor?.isConnected) return hide();
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(form.hidden ? 440 : 360, window.innerWidth - 24);
    popover.style.width = `${width}px`;
    popover.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    const height = popover.getBoundingClientRect().height;
    const below = rect.bottom + 7;
    popover.style.top = `${Math.max(42, below + height < window.innerHeight - 12 ? below : rect.top - height - 7)}px`;
  }
  function show(link: HTMLAnchorElement) {
    window.clearTimeout(closeTimer);
    if (!form.hidden && anchor === link) return;
    anchor = link;
    range = getMarkRange(editor.state.doc.resolve(editor.view.posAtDOM(link, 0)), editor.schema.marks.link!) ?? null;
    if (!range) return hide();
    urlText.textContent = link.getAttribute("href") ?? "";
    destination.title = urlText.textContent;
    destination.disabled = !externalUrl(urlText.textContent);
    edit.disabled = !editor.isEditable;
    preview.hidden = false;
    form.hidden = true;
    error.textContent = "";
    status.textContent = "";
    popover.hidden = false;
    position();
  }
  function leave() {
    window.clearTimeout(closeTimer);
    if (form.hidden && !popover.contains(document.activeElement)) closeTimer = window.setTimeout(hide, 220);
  }
  function linkAt(target: EventTarget | null) {
    const link = target instanceof Element ? target.closest("a[href]") : null;
    return link && root.contains(link) ? link as HTMLAnchorElement : null;
  }
  const hover = (event: MouseEvent) => { const link = linkAt(event.target); if (link) show(link); };
  const focus = (event: FocusEvent) => { const link = linkAt(event.target); if (link) show(link); };
  const open = async (value: string) => {
    const safe = externalUrl(value);
    if (!safe) return;
    try { await openUrl(safe); } catch { status.textContent = "Could not open this link."; popover.hidden = false; position(); }
  };
  const click = (event: MouseEvent) => {
    const link = linkAt(event.target);
    if (!link || (event.type === "auxclick" && event.button !== 1)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.detail > 0 && window.getSelection()?.isCollapsed === false) return;
    void open(link.getAttribute("href") ?? "");
  };
  destination.addEventListener("click", () => { if (anchor) void open(anchor.getAttribute("href") ?? ""); });
  copy.addEventListener("click", async () => {
    if (!anchor) return;
    try { await copyLink(anchor.getAttribute("href") ?? ""); if (!destroyed) status.textContent = "Copied"; }
    catch { if (!destroyed) status.textContent = "Could not copy this link."; }
    position();
  });
  edit.addEventListener("click", () => {
    if (!range || !editor.isEditable) return;
    label.value = editor.state.doc.textBetween(range.from, range.to, "");
    url.value = anchor?.getAttribute("href") ?? "";
    form.hidden = false;
    preview.hidden = true;
    error.textContent = "";
    status.textContent = "";
    position();
    url.focus();
    url.select();
  });
  cancel.addEventListener("click", hide);
  remove.addEventListener("click", () => {
    if (!range || !editor.isEditable) return;
    editor.view.dispatch(editor.state.tr.removeMark(range.from, range.to, editor.schema.marks.link!));
    hide();
    editor.view.focus();
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!range || !editor.isEditable) return;
    const value = url.value.trim();
    const safe = externalUrl(value) ?? (!/^[a-z][a-z\d+.-]*:/i.test(value) ? externalUrl(`https://${value}`) : null);
    if (!safe || !label.value.trim()) { error.textContent = "Enter link text and an http, https or mailto URL."; position(); return; }
    const { from, to } = range;
    const oldText = editor.state.doc.textBetween(from, to, "");
    const oldMarks = editor.state.doc.resolve(from).nodeAfter?.marks ?? [];
    const attrs = { ...oldMarks.find(mark => mark.type.name === "link")?.attrs, href: safe };
    const tr = editor.state.tr;
    if (label.value === oldText) tr.removeMark(from, to, editor.schema.marks.link!).addMark(from, to, editor.schema.marks.link!.create(attrs));
    else tr.replaceWith(from, to, editor.schema.text(label.value, [...oldMarks.filter(mark => mark.type.name !== "link"), editor.schema.marks.link!.create(attrs)]));
    hide();
    editor.view.dispatch(tr);
    editor.view.focus();
  });
  const outside = (event: PointerEvent) => { if (!popover.contains(event.target as globalThis.Node) && !linkAt(event.target)) hide(); };
  const transaction = ({ transaction: tr }: { transaction: import("@tiptap/pm/state").Transaction }) => {
    if (!range || !tr.docChanged) return;
    range = { from: tr.mapping.map(range.from), to: tr.mapping.map(range.to, -1) };
    if (tr.getMeta("preventUpdate") || range.from >= range.to || !anchor?.isConnected) hide();
    else position();
  };
  root.addEventListener("mouseover", hover);
  root.addEventListener("mouseout", leave);
  root.addEventListener("focusin", focus);
  root.addEventListener("click", click);
  root.addEventListener("auxclick", click);
  popover.addEventListener("mouseenter", () => window.clearTimeout(closeTimer));
  popover.addEventListener("mouseleave", leave);
  popover.addEventListener("focusin", () => window.clearTimeout(closeTimer));
  popover.addEventListener("focusout", event => { if (!popover.contains(event.relatedTarget as globalThis.Node | null)) leave(); });
  document.addEventListener("pointerdown", outside);
  window.addEventListener("scroll", position, { passive: true });
  window.addEventListener("resize", position);
  editor.on("transaction", transaction);
  return { destroy() {
    destroyed = true;
    hide();
    root.removeEventListener("mouseover", hover);
    root.removeEventListener("mouseout", leave);
    root.removeEventListener("focusin", focus);
    root.removeEventListener("click", click);
    root.removeEventListener("auxclick", click);
    document.removeEventListener("pointerdown", outside);
    window.removeEventListener("scroll", position);
    window.removeEventListener("resize", position);
    editor.off("transaction", transaction);
    popover.remove();
  } };
}
