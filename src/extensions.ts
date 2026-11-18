import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { DocumentImage } from "./images";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { ColumnWidthTableView } from "./table-view";
import { HtmlComment, InlineHtmlComment, CommentFocus } from "./comments";
import { FootnoteReference, FootnoteDefinition } from "./footnotes";
import { FootnoteOrder, UnusedFootnote } from "./footnote-order";
import { SpeechHighlight } from "./speech-highlight";

export const extensions = [
  StarterKit.configure({ link: { openOnClick: false }, trailingNode: { notAfter: ["footnoteDefinition", "unusedFootnote"] } }),
  Markdown,
  HtmlComment,
  InlineHtmlComment,
  CommentFocus,
  FootnoteReference,
  FootnoteDefinition,
  UnusedFootnote,
  FootnoteOrder,
  SpeechHighlight,
  DocumentImage,
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: true, View: ColumnWidthTableView }),
  TableRow,
  TableHeader,
  TableCell,
];
