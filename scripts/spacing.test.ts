import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
for (const k of ["Node", "Element", "HTMLElement", "DOMParser", "MutationObserver", "getComputedStyle", "Range", "Text", "Document"]) {
  g[k] = (dom.window as any)[k];
}

const { Editor } = await import("@tiptap/core");
const { extensions } = await import("../src/extensions");
const { loadMarkdown } = await import("../src/document");
const { normalizeMarkdown, commentFocusKey } = await import("../src/comments");
const editors: InstanceType<typeof Editor>[] = [];
function open(content: string) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({ element, extensions, content, contentType: "markdown" });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy());
  document.body.replaceChildren();
});

const plain = "First paragraph.\n\nSecond paragraph.";
const comment = "<!-- Editorial note: clarify this. -->";
const annotated = `First paragraph.\n\n${comment}\n\nSecond paragraph.`;

test("standalone editorial comments preserve source without empty paragraphs", () => {
  const editor = open(annotated);
  expect(editor.getJSON().content?.map(node => node.type)).toEqual(["paragraph", "htmlComment", "paragraph"]);
  expect(editor.view.dom.querySelectorAll("p").length).toBe(2);
  const hidden = editor.view.dom.querySelector("[data-html-comment]") as HTMLElement;
  expect(getComputedStyle(hidden).display).toBe("none");
  expect(hidden.hidden).toBe(true);
  expect(editor.getMarkdown()).toBe(annotated);
});

test("activating a margin comment highlights its paragraph without editing the document", async () => {
  const editor = open(annotated);
  let updates = 0;
  editor.on("update", () => updates++);
  const id = editor.getJSON().content?.[1]?.attrs?.id;
  editor.view.dispatch(editor.state.tr.setMeta(commentFocusKey, { id }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(editor.view.dom.querySelector(".comment-anchor-active")?.textContent).toBe("First paragraph.");
  expect(editor.getMarkdown()).toBe(annotated);
  expect(updates).toBe(0);
});

test("multiline and consecutive comments survive repeated parsing", () => {
  const source = "First.\n\n<!-- Editorial note:\nkeep this text. -->\n\n<!-- Another note. -->\n\nLast.";
  const editor = open(source);
  for (let i = 0; i < 3; i++) {
    expect(editor.getMarkdown()).toBe(source);
    expect(editor.view.dom.querySelectorAll("p").length).toBe(2);
    loadMarkdown(editor, editor.getMarkdown());
  }
});

test("real blank paragraphs and comment examples in code remain intact", () => {
  const source = `First.\n\n\n\nSecond.\n\n\`\`\`html\n${comment}\n\`\`\``;
  const editor = open(source);
  expect(editor.getJSON().content?.map(node => node.type)).toEqual(["paragraph", "paragraph", "paragraph", "codeBlock"]);
  expect(editor.getMarkdown()).toBe(source);
  expect(loadMarkdown(editor, source)).toBeNull();
  expect(editor.isEditable).toBe(true);
});

test("comments stay editable on external reload without scheduling saves", () => {
  const editor = open(plain);
  let updates = 0;
  editor.on("update", () => updates++);
  expect(loadMarkdown(editor, plain)).toBeNull();
  expect(editor.isEditable).toBe(true);
  expect(loadMarkdown(editor, annotated)).toBeNull();
  expect(editor.isEditable).toBe(true);
  expect(editor.getMarkdown()).toBe(annotated);
  expect(editor.view.dom.querySelectorAll("p").length).toBe(2);
  expect(loadMarkdown(editor, plain)).toBeNull();
  expect(editor.isEditable).toBe(true);
  expect(updates).toBe(0);
});

test("inline comments survive prose edits and round trips", () => {
  const source = "First <!-- keep **literal** & <tags> -->paragraph.\n\nSecond.";
  const editor = open(source);
  expect(loadMarkdown(editor, source)).toBeNull();
  expect(editor.getMarkdown()).toBe(source);
  expect(editor.getJSON().content?.[0]?.content?.some(node => node.type === "inlineHtmlComment")).toBe(true);
  editor.commands.insertContentAt(1, "Edited ");
  expect(editor.getMarkdown()).toBe(`Edited ${source}`);
  loadMarkdown(editor, editor.getMarkdown());
  expect(editor.getMarkdown()).toBe(`Edited ${source}`);
});

test("normalization preserves comment whitespace and entities", () => {
  const source = "First.\n\n<!-- Line one\n\n\nLine two\n&nbsp;\n-->\n\nLast.";
  const editor = open(source);
  expect(normalizeMarkdown(editor.getMarkdown())).toBe(source + "\n");
});

test("comments in lists and tables remain standard Markdown", () => {
  const source = "- A list item<!-- list note -->\n\n| Column |\n| --- |\n| Cell<!-- table note --> |";
  const editor = open(source);
  expect(loadMarkdown(editor, source)).toBeNull();
  const serialized = editor.getMarkdown();
  expect(serialized).toContain("<!-- list note -->");
  expect(serialized).toContain("<!-- table note -->");
  loadMarkdown(editor, serialized);
  expect(editor.getMarkdown()).toBe(serialized);
});

test("comment-like strings in code and escaped text are not comments", () => {
  const editor = open(`Text \`${comment}\` and \\<strong>.\n\n\`\`\`html\n${comment}\n\`\`\``);
  expect(editor.getJSON().content?.some(node => node.type === "htmlComment")).toBe(false);
  expect(editor.view.dom.querySelectorAll("[data-html-comment]").length).toBe(0);
  expect(loadMarkdown(editor, editor.getMarkdown())).toBeNull();
});

test("malformed comments and inline HTML cannot bypass read-only protection", () => {
  const editor = open(plain);
  for (const source of ["<!-- unclosed", "<!-- note -->trailing HTML block text", "Text <strong>bold</strong>."]) {
    expect(loadMarkdown(editor, source)).toBe("HTML");
    expect(editor.isEditable).toBe(false);
  }
});

test("other raw HTML and footnotes still use the read-only safety policy", () => {
  const editor = open(plain);
  for (const [source, reason] of [["<div>HTML content</div>", "HTML"], ["Text[^1]\n\n[^1]: Note", "footnotes"]]) {
    expect(loadMarkdown(editor, source!)).toBe(reason);
    expect(editor.isEditable).toBe(false);
    expect(editor.getJSON().content?.some(node => node.type === "htmlComment")).toBe(false);
  }
});
