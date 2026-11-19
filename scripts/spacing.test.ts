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
const { externalUrl, copyLink } = await import("../src/link-ui");
const { localImagePath } = await import("../src/images");
const { NodeSelection } = await import("@tiptap/pm/state");
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

const marked = (editor: InstanceType<typeof Editor>) => {
  const ranges: { text: string; note: string }[] = [];
  editor.state.doc.descendants(node => {
    for (const mark of node.marks) if (mark.type.name === "commentRange") ranges.push({ text: node.text!, note: mark.attrs.text });
  });
  return ranges;
};

test("a comment on exact words is a mark in the editor and paired comments in the file", () => {
  const source = "The <!-- comment: Which fox? -->quick<!-- /comment --> brown fox.";
  const editor = open(source);
  expect(loadMarkdown(editor, source)).toBeNull();
  expect(editor.isEditable).toBe(true);
  expect(marked(editor)).toEqual([{ text: "quick", note: "Which fox?" }]);
  expect(editor.getJSON().content?.[0]?.content?.some(node => node.type === "inlineHtmlComment")).toBe(false);
  expect(editor.getMarkdown()).toBe(source);
  const span = editor.view.dom.querySelector("[data-comment-id]")!;
  expect(span.textContent).toBe("quick");
  editor.commands.insertContentAt(1, "Edited ");
  expect(editor.getMarkdown()).toBe(`Edited ${source}`);
  loadMarkdown(editor, editor.getMarkdown());
  expect(marked(editor)).toEqual([{ text: "quick", note: "Which fox?" }]);
});

test("a comment on the first words of a paragraph stays an editable paragraph", () => {
  for (const source of [
    "<!-- comment: Start here -->The quick<!-- /comment --> brown fox.\n\nNext.",
    "- <!-- comment: In a list -->Item<!-- /comment --> one\n- Two\n\nEnd.",
    "<!-- comment: Two\nlines -->Whole line<!-- /comment -->",
  ]) {
    const editor = open("Placeholder");
    expect(loadMarkdown(editor, source)).toBeNull();
    expect(editor.isEditable).toBe(true);
    expect(marked(editor).length).toBe(1);
    expect(editor.getMarkdown()).toBe(source);
  }
});

test("comments on formatted, nested and adjacent words round trip", () => {
  const sources = [
    "A <!-- comment: Bold word -->**strong**<!-- /comment --> and *calm* words.",
    "<!-- comment: Outer -->One <!-- comment: Inner -->two<!-- /comment --> three<!-- /comment --> four.",
    "<!-- comment: A -->One<!-- /comment --><!-- comment: B -->two<!-- /comment -->",
    "See <!-- comment: Link -->[the docs](https://example.com)<!-- /comment --> and a note[^1].\n\n[^1]: Note.",
  ];
  for (const source of sources) {
    const editor = open("Placeholder");
    expect(loadMarkdown(editor, source)).toBeNull();
    expect(marked(editor).length).toBeGreaterThan(0);
    const saved = editor.getMarkdown();
    expect(saved).toBe(source);
    loadMarkdown(editor, saved);
    expect(editor.getMarkdown()).toBe(source);
  }
});

test("an unpaired or empty range comment stays a plain comment and nothing is lost", () => {
  for (const source of ["An <!-- comment: Alone -->open note.", "A stray<!-- /comment --> closer.", "Empty<!-- comment: None --><!-- /comment --> range."]) {
    const editor = open("Placeholder");
    expect(loadMarkdown(editor, source)).toBeNull();
    expect(marked(editor)).toEqual([]);
    expect(editor.getMarkdown()).toBe(source);
  }
});

test("adding a range comment to a selection saves paired comments around exactly those words", () => {
  const editor = open("The quick brown fox.");
  const from = 5;
  editor.view.dispatch(editor.state.tr.addMark(from, from + 5, editor.schema.marks.commentRange!.create({ id: "new", text: "Too vague." })));
  expect(editor.getMarkdown()).toBe("The <!-- comment: Too vague. -->quick<!-- /comment --> brown fox.");
  editor.commands.insertContentAt(from + 5, "er");
  expect(marked(editor)).toEqual([{ text: "quick", note: "Too vague." }]);
  expect(editor.getMarkdown()).toBe("The <!-- comment: Too vague. -->quick<!-- /comment -->er brown fox.");
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

test("other raw HTML still uses the read-only safety policy", () => {
  const editor = open(plain);
  for (const [source, reason] of [["<div>HTML content</div>", "HTML"]]) {
    expect(loadMarkdown(editor, source!)).toBe(reason);
    expect(editor.isEditable).toBe(false);
    expect(editor.getJSON().content?.some(node => node.type === "htmlComment")).toBe(false);
  }
});

test("named and repeated footnotes round-trip without making the file read-only", () => {
  const source = "Text[^source] and again[^source].\n\n[^source]: A **bold** note with [a link](https://example.com).";
  const editor = open(source);
  expect(loadMarkdown(editor, source)).toBeNull();
  expect(editor.isEditable).toBe(true);
  expect(editor.view.dom.querySelectorAll("[data-footnote-reference]").length).toBe(2);
  expect(editor.view.dom.querySelectorAll("[data-footnote-definition]").length).toBe(1);
  expect(editor.getMarkdown()).toBe(source);
  editor.commands.insertContentAt(1, "Edited ");
  expect(editor.getMarkdown()).toBe("Edited " + source);
});

test("multiline footnotes preserve paragraphs, lists, and comments", () => {
  const source = "Text[^1].\n\n[^1]: First paragraph.\n\n    Second paragraph.\n\n    - A list item\n    - Another<!-- note -->";
  const editor = open(source);
  expect(loadMarkdown(editor, source)).toBeNull();
  const saved = editor.getMarkdown();
  expect(saved).toContain("    Second paragraph.");
  expect(saved).toContain("<!-- note -->");
  loadMarkdown(editor, saved);
  expect(editor.getMarkdown()).toBe(saved);
});

test("undefined references and unused definitions survive editing", () => {
  const source = "[^unused]: Keep me.\n\nText[^missing].";
  const editor = open(source);
  loadMarkdown(editor, source);
  expect(editor.getMarkdown()).toBe("Text[^missing].\n\n[^unused]: Keep me.");
  expect(editor.view.dom.querySelector("[data-footnote-definition]")).toBeNull();
  expect(editor.view.dom.querySelector("[data-unused-footnote]")).not.toBeNull();
  expect(editor.view.dom.querySelector("[data-footnote-reference] button")?.getAttribute("title")).toBe("Missing footnote definition");
});

test("notes are collected at the end in first-reference order, not definition order", () => {
  const source = "First[^b].\n\n[^a]: Note A.\n\nLast[^a].\n\n[^b]: Note B.";
  const editor = open(plain);
  let updates = 0;
  editor.on("update", () => updates++);
  loadMarkdown(editor, source);
  expect(editor.getJSON().content?.map(node => node.type)).toEqual(["paragraph", "paragraph", "footnoteDefinition", "footnoteDefinition"]);
  expect([...editor.view.dom.querySelectorAll<HTMLElement>("[data-footnote-definition]")].map(node => node.dataset.label)).toEqual(["b", "a"]);
  expect([...editor.view.dom.querySelectorAll(".footnote-number")].map(node => node.textContent)).toEqual(["1", "2"]);
  expect(updates).toBe(0);
  expect(editor.can().undo()).toBe(false);
});

test("deleting the last reference removes its definition and undo restores both", () => {
  const editor = open(plain);
  loadMarkdown(editor, "Text[^a]\n\n[^a]: Keep this note on undo.");
  let pos = 0;
  editor.state.doc.descendants((node, index) => { if (node.type.name === "footnoteReference") pos = index; });
  editor.commands.deleteRange({ from: pos, to: pos + 1 });
  expect(editor.getMarkdown()).not.toContain("Keep this note");
  expect(editor.view.dom.querySelector("[data-footnote-definition]")).toBeNull();
  expect(editor.commands.undo()).toBe(true);
  expect(editor.getMarkdown()).toContain("Text[^a]");
  expect(editor.getMarkdown()).toContain("[^a]: Keep this note on undo.");
  expect(editor.view.dom.querySelectorAll("[data-footnote-definition]").length).toBe(1);
  editor.commands.redo();
  expect(editor.getMarkdown()).not.toContain("[^a]");
});

test("a repeated note survives until its final reference is deleted", () => {
  const editor = open(plain);
  loadMarkdown(editor, "One[^a] two[^a]\n\n[^a]: Shared note.");
  const removeFirst = () => {
    let pos: number | undefined;
    editor.state.doc.descendants((node, index) => { if (node.type.name === "footnoteReference") pos ??= index; });
    editor.commands.deleteRange({ from: pos!, to: pos! + 1 });
  };
  removeFirst();
  expect(editor.view.dom.querySelectorAll("[data-footnote-definition]").length).toBe(1);
  expect(editor.getMarkdown()).toContain("Shared note.");
  removeFirst();
  expect(editor.getMarkdown()).not.toContain("Shared note.");
});

test("cut reference metadata restores its note when pasted back", () => {
  const editor = open(plain);
  loadMarkdown(editor, "Text[^a]\n\n[^a]: A cut note.");
  let reference: any;
  let pos = 0;
  editor.state.doc.descendants((node, index) => { if (node.type.name === "footnoteReference") { reference = node.toJSON(); pos = index; } });
  expect(reference.attrs.definition.type).toBe("footnoteDefinition");
  editor.commands.deleteRange({ from: pos, to: pos + 1 });
  expect(editor.getMarkdown()).not.toContain("A cut note.");
  editor.commands.insertContentAt(pos, reference);
  expect(editor.getMarkdown()).toContain("[^a]: A cut note.");
  expect(editor.view.dom.querySelectorAll("[data-footnote-definition]").length).toBe(1);
});

test("GitHub two-space and tab-indented footnote continuations stay inside the note", () => {
  for (const indent of ["  ", "\t"]) {
    const editor = open(`Text[^1].\n\n[^1]: First line.\n${indent}Second line.\n\n${indent}A second paragraph.`);
    const note = editor.getJSON().content?.find(node => node.type === "footnoteDefinition");
    expect(note?.content?.length).toBe(2);
    expect(editor.view.dom.querySelector(".footnote-content")?.textContent).toContain("A second paragraph.");
    const saved = editor.getMarkdown();
    loadMarkdown(editor, saved);
    expect(editor.getMarkdown()).toBe(saved);
  }
});

test("footnote examples in code stay literal and raw HTML inside notes stays protected", () => {
  const source = "Example `[^label]`.\n\n```md\n[^label]: Literal example\n```";
  const editor = open(source);
  expect(editor.view.dom.querySelector("[data-footnote-reference]")).toBeNull();
  expect(editor.view.dom.querySelector("[data-footnote-definition]")).toBeNull();
  expect(editor.getMarkdown()).toBe(source);
  expect(loadMarkdown(editor, "Text[^1]\n\n[^1]: <script>unsafe</script>")).toBe("HTML");
});

test("link destinations only open safe external URL schemes", () => {
  expect(externalUrl("https://example.com/path")).toBe("https://example.com/path");
  expect(externalUrl("mailto:hello@example.com")).toBe("mailto:hello@example.com");
  for (const value of ["javascript:alert(1)", "data:text/html,hello", "file:///etc/passwd", "/relative", "not a URL"]) expect(externalUrl(value)).toBeNull();
});

test("the native WebView clipboard fallback copies without changing document content", async () => {
  let copied = "";
  const previous = (document as any).execCommand;
  (document as any).execCommand = (command: string) => {
    expect(command).toBe("copy");
    copied = (document.activeElement as HTMLTextAreaElement).value;
    return true;
  };
  try {
    await copyLink("https://example.com/copied");
    expect(copied).toBe("https://example.com/copied");
    expect(document.querySelector("textarea")).toBeNull();
  } finally { (document as any).execCommand = previous; }
});

test("local image rendering resolves against the document without changing its Markdown path", () => {
  expect(localImagePath("assets/my%20photo.png", "/Users/example/My notes/note.md")).toBe("/Users/example/My notes/assets/my photo.png");
  expect(localImagePath("https://example.com/picture.png", "/notes/file.md")).toBeNull();
  const source = "![A \\[bracket\\] photo](assets/my%20photo.png)";
  const editor = open(source);
  expect(editor.getMarkdown().trim()).toBe(source);
  expect(editor.getJSON().content?.[0]?.attrs?.src).toBe("assets/my%20photo.png");
});

test("image filenames with spaces and parentheses serialize as valid Markdown", () => {
  const editor = open("Text.");
  editor.commands.setImage({ src: "assets/my photo (1).png", alt: "A [label]" });
  expect(editor.getMarkdown()).toContain("![A \\[label\\]](assets/my%20photo%20%281%29.png)");
});

test("whole-image and range selection never modify image Markdown or emit edits", () => {
  const source = "Before.\n\n![A picture](assets/picture.png)\n\nAfter.";
  const editor = open(plain);
  loadMarkdown(editor, source);
  let pos = 0;
  editor.state.doc.descendants((node, index) => { if (node.type.name === "image") pos = index; });
  let updates = 0;
  editor.on("update", () => updates++);
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
  const image = editor.view.dom.querySelector(".document-image")!;
  expect(image.classList.contains("ProseMirror-selectednode")).toBe(true);
  expect(image.classList.contains("image-in-selection")).toBe(true);
  expect(editor.schema.nodes.image?.spec.draggable).toBe(false);
  editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
  expect(image.classList.contains("image-in-selection")).toBe(true);
  editor.commands.setTextSelection(1);
  expect(image.classList.contains("image-in-selection")).toBe(false);
  expect(editor.getMarkdown()).toBe(source);
  expect(updates).toBe(0);
});
