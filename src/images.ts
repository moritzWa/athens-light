import Image from "@tiptap/extension-image";
import type { Editor } from "@tiptap/core";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { NodeSelection } from "@tiptap/pm/state";
import "./images.css";

const paths = new WeakMap<Editor, string>();
const reloads = new WeakMap<Editor, { versions: Map<string, string | null>; listeners: Set<() => void> }>();

// One bounded batch per document, not one timer per image. No document
// transactions are needed, so refreshes cannot save Markdown or enter undo.
export function mountImageReload(editor: Editor) {
  const state = { versions: new Map<string, string | null>(), listeners: new Set<() => void>() };
  reloads.set(editor, state);
  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout>;
  const refresh = async () => {
    if (stopped || busy) return;
    busy = true;
    const documentPath = paths.get(editor);
    try {
      const localPaths = new Set<string>();
      editor.state.doc.descendants(node => {
        if (node.type.name !== "image" || !documentPath) return;
        try {
          const local = localImagePath(String(node.attrs.src ?? ""), documentPath);
          if (local) localPaths.add(local);
        } catch { /* A malformed URL must not stop other images refreshing. */ }
      });
      const sources = [...localPaths];
      if (sources.length) {
        const versions = await invoke<(string | null)[]>("image_versions", { paths: sources });
        if (stopped || paths.get(editor) !== documentPath) return;
        sources.forEach((source, index) => state.versions.set(source, versions[index]));
        for (const listener of state.listeners) listener();
      }
      for (const source of state.versions.keys()) if (!localPaths.has(source)) state.versions.delete(source);
    } catch (error) {
      console.warn("Could not check external images", error);
    } finally {
      busy = false;
      if (!stopped) timer = setTimeout(refresh, 1000);
    }
  };
  const focus = () => { clearTimeout(timer); void refresh(); };
  window.addEventListener("focus", focus);
  void refresh();
  return () => {
    stopped = true;
    clearTimeout(timer);
    window.removeEventListener("focus", focus);
    state.listeners.clear();
    reloads.delete(editor);
  };
}
export async function copySelectedImage(editor: Editor) {
  const selection = editor.state.selection;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== "image") throw new Error("Select an image first");
  const source = String(selection.node.attrs.src ?? "");
  const path = paths.get(editor);
  await invoke("copy_image_to_clipboard", { source: path ? localImagePath(source, path) ?? source : source });
}
export function setImageDocumentPath(editor: Editor, path: string) {
  paths.set(editor, path);
  editor.view.dispatch(editor.state.tr.setMeta("imageBase", true));
}

export function localImagePath(source: string, documentPath: string): string | null {
  if (/^(?:https?:|data:|blob:)/i.test(source)) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(source) && !source.startsWith("file:")) return null;
  const base = "file:///" + documentPath.replace(/^\//, "").split("/").map(encodeURIComponent).join("/");
  return decodeURIComponent(new URL(source, base).pathname);
}

export const DocumentImage = Image.extend({
  draggable: false,
  renderMarkdown: node => {
    const source = String(node.attrs?.src ?? "").replace(/[\s<>]/g, encodeURIComponent).replace(/\(/g, "%28").replace(/\)/g, "%29");
    const alt = String(node.attrs?.alt ?? "").replace(/[\\[\]]/g, "\\$&").replace(/\r?\n/g, " ");
    const title = String(node.attrs?.title ?? "").replace(/[\\"]/g, "\\$&").replace(/\r?\n/g, " ");
    return title ? `![${alt}](${source} "${title}")` : `![${alt}](${source})`;
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("div");
      dom.className = "document-image";
      dom.contentEditable = "false";
      dom.draggable = false;
      const image = document.createElement("img");
      image.alt = node.attrs.alt ?? "";
      image.draggable = false;
      if (node.attrs.title) image.title = node.attrs.title;
      // Keep hit testing off the bitmap itself. In WKWebView, hitting the img
      // can activate macOS Live Text instead of selecting the document node.
      const overlay = document.createElement("span");
      overlay.className = "image-selection-overlay";
      overlay.setAttribute("aria-hidden", "true");
      dom.append(image, overlay);
      const select = (event: PointerEvent) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const pos = getPos();
        if (typeof pos !== "number") return;
        editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
        editor.view.focus();
      };
      dom.addEventListener("pointerdown", select);
      let previous = "";
      const update = () => {
        const pos = getPos();
        const selection = editor.state.selection;
        dom.classList.toggle("image-in-selection", typeof pos === "number" && selection.from <= pos && selection.to >= pos + node.nodeSize);
        const path = paths.get(editor);
        const source = node.attrs.src ?? "";
        try {
          const local = path ? localImagePath(source, path) : null;
          const version = local ? reloads.get(editor)?.versions.get(local) : undefined;
          const identity = JSON.stringify([path, source, version]);
          if (identity === previous) return;
          previous = identity;
          const url = local ? convertFileSrc(local) : source;
          image.src = local && version !== undefined ? `${url}${url.includes("?") ? "&" : "?"}athensAsset=${encodeURIComponent(version ?? "missing")}` : url;
        } catch { image.removeAttribute("src"); }
      };
      update();
      const listeners = reloads.get(editor)?.listeners;
      listeners?.add(update);
      editor.on("transaction", update);
      return {
        dom,
        ignoreMutation: mutation => mutation.type !== "selection",
        stopEvent: event => ["pointerdown", "mousedown", "click", "dblclick", "dragstart"].includes(event.type),
        destroy: () => { listeners?.delete(update); editor.off("transaction", update); dom.removeEventListener("pointerdown", select); },
      };
    };
  },
});
