import type { Editor } from "@tiptap/core";
import { unsupportedSyntax } from "./frontmatter";
import { history } from "@tiptap/pm/history";

// Apply the same safety policy on initial open and every external reload.
// setEditable normally emits an update, which would schedule an unwanted save.
export function loadMarkdown(editor: Editor, body: string): string | null {
  const unsupported = unsupportedSyntax(body);
  editor.chain().setMeta("addToHistory", false).setContent(body, { contentType: "markdown", emitUpdate: false }).run();
  // Opening/reloading a file is not an undoable user edit. In particular, Undo
  // must not restore a previous external version or erase a newly opened file.
  editor.unregisterPlugin("history");
  editor.registerPlugin(history());
  editor.setEditable(!unsupported, false);
  return unsupported;
}
