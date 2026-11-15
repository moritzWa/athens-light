import Image from "@tiptap/extension-image";
import type { Editor } from "@tiptap/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { NodeSelection } from "@tiptap/pm/state";
import "./images.css";

const paths = new WeakMap<Editor, string>();
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
        const identity = `${path}\n${source}`;
        if (identity === previous) return;
        previous = identity;
        try {
          const local = path ? localImagePath(source, path) : null;
          image.src = local ? convertFileSrc(local) : source;
        } catch { image.removeAttribute("src"); }
      };
      update();
      editor.on("transaction", update);
      return {
        dom,
        ignoreMutation: mutation => mutation.type !== "selection",
        stopEvent: event => ["pointerdown", "mousedown", "click", "dblclick", "dragstart"].includes(event.type),
        destroy: () => { editor.off("transaction", update); dom.removeEventListener("pointerdown", select); },
      };
    };
  },
});
