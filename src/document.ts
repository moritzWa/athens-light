import type { Editor } from "@tiptap/core";
import { unsupportedSyntax } from "./frontmatter";
import { history } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";

// Apply the same safety policy on initial open and every external reload.
// setEditable normally emits an update, which would schedule an unwanted save.
// Remember the caret and scroll position, and return a function that puts them
// back after the content was replaced. Positions inside the changed region
// fall back to its start; positions after it shift with the new length.
export function keepPlace(editor: Editor): () => void {
  const { doc, selection } = editor.state;
  const scroller = document.scrollingElement;
  const top = scroller?.scrollTop ?? 0;
  return () => {
    const next = editor.state.doc;
    const start = doc.content.findDiffStart(next.content);
    const end = start === null ? null : doc.content.findDiffEnd(next.content)!;
    const map = (pos: number) => (start === null || end === null || pos <= start ? pos : pos >= Math.max(end.a, start) ? pos + end.b - end.a : start);
    const clamp = (pos: number) => Math.max(0, Math.min(pos, next.content.size));
    const restored = TextSelection.between(next.resolve(clamp(map(selection.anchor))), next.resolve(clamp(map(selection.head))));
    editor.view.dispatch(editor.state.tr.setSelection(restored).setMeta("addToHistory", false));
    if (scroller) scroller.scrollTop = top;
  };
}

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
