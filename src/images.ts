import Image from "@tiptap/extension-image";
import type { Editor } from "@tiptap/core";
import { convertFileSrc } from "@tauri-apps/api/core";

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
  renderMarkdown: node => {
    const source = String(node.attrs?.src ?? "").replace(/[\s<>]/g, encodeURIComponent).replace(/\(/g, "%28").replace(/\)/g, "%29");
    const alt = String(node.attrs?.alt ?? "").replace(/[\\[\]]/g, "\\$&").replace(/\r?\n/g, " ");
    const title = String(node.attrs?.title ?? "").replace(/[\\"]/g, "\\$&").replace(/\r?\n/g, " ");
    return title ? `![${alt}](${source} "${title}")` : `![${alt}](${source})`;
  },
  addNodeView() {
    return ({ node, editor }) => {
      const dom = document.createElement("img");
      dom.alt = node.attrs.alt ?? "";
      if (node.attrs.title) dom.title = node.attrs.title;
      let previous = "";
      const update = () => {
        const path = paths.get(editor);
        const source = node.attrs.src ?? "";
        const identity = `${path}\n${source}`;
        if (identity === previous) return;
        previous = identity;
        try {
          const local = path ? localImagePath(source, path) : null;
          dom.src = local ? convertFileSrc(local) : source;
        } catch { dom.removeAttribute("src"); }
      };
      update();
      editor.on("transaction", update);
      return { dom, ignoreMutation: () => true, destroy: () => editor.off("transaction", update) };
    };
  },
});
