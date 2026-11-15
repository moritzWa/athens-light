import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import Image from "@tiptap/extension-image";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { HtmlComment, InlineHtmlComment, CommentFocus } from "./comments";

export const extensions = [
  StarterKit.configure({ link: { openOnClick: false } }),
  Markdown,
  HtmlComment,
  InlineHtmlComment,
  CommentFocus,
  Image,
  TaskList,
  TaskItem.configure({ nested: true }),
  Table,
  TableRow,
  TableHeader,
  TableCell,
];
