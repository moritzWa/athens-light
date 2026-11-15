import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import Image from "@tiptap/extension-image";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { Node } from "@tiptap/core";

// The HTML fallback turns a standalone comment into an empty paragraph. Keep
// the source in an invisible block instead, without introducing a blank line.
const HtmlComment = Node.create({
  name: "htmlComment",
  group: "block",
  atom: true,
  selectable: false,
  addAttributes: () => ({ source: { default: "", rendered: false } }),
  parseHTML: () => [{ tag: "div[data-html-comment]" }],
  renderHTML: () => ["div", { "data-html-comment": "", hidden: "", style: "display: none", "aria-hidden": "true" }],
  markdownTokenName: "html",
  parseMarkdown: (token) => {
    const source = token.raw ?? "";
    if (!token.block || !/^(?:\s*<!--[\s\S]*?-->)+\s*$/.test(source)) return [];
    return { type: "htmlComment", attrs: { source } };
  },
  renderMarkdown: (node) => node.attrs?.source.trimEnd() ?? "",
});

export const extensions = [
  StarterKit.configure({ link: { openOnClick: false } }),
  Markdown,
  HtmlComment,
  Image,
  TaskList,
  TaskItem.configure({ nested: true }),
  Table,
  TableRow,
  TableHeader,
  TableCell,
];
