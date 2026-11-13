import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='e'></div></body></html>");
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
for (const k of ["Node", "Element", "HTMLElement", "DOMParser", "MutationObserver", "getComputedStyle", "Range", "Text", "Document"]) {
  g[k] = (dom.window as any)[k];
}

const { Editor } = await import("@tiptap/core");
const { extensions } = await import("../src/extensions");
const { splitFrontMatter, unsupportedSyntax } = await import("../src/frontmatter");

const raw = await Bun.file(process.argv[2]).text();
const { front, body: input } = splitFrontMatter(raw);
console.log("unsupported:", unsupportedSyntax(input));
const editor = new Editor({
  element: document.getElementById("e")!,
  extensions,
  content: input,
  contentType: "markdown",
});
console.log(front + editor.getMarkdown());
