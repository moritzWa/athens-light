import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import Image from "@tiptap/extension-image";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { HtmlComment, InlineHtmlComment, CommentFocus } from "./comments";
import { FootnoteReference, FootnoteDefinition } from "./footnotes";

export const extensions = [
  StarterKit.configure({ link: { openOnClick: false }, trailingNode: { notAfter: ["footnoteDefinition"] } }),
  Markdown,
  HtmlComment,
  InlineHtmlComment,
  CommentFocus,
  FootnoteReference,
  FootnoteDefinition,
  Image,
  TaskList,
  TaskItem.configure({ nested: true }),
  Table,
  TableRow,
  TableHeader,
  TableCell,
];
