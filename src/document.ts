import type { Editor } from "@tiptap/core";
import { unsupportedSyntax } from "./frontmatter";

// Apply the same safety policy on initial open and every external reload.
// setEditable normally emits an update, which would schedule an unwanted save.
export function loadMarkdown(editor: Editor, body: string): string | null {
  const unsupported = unsupportedSyntax(body);
  editor.commands.setContent(body, { contentType: "markdown", emitUpdate: false });
  editor.setEditable(!unsupported, false);
  return unsupported;
}
