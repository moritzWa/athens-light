import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

test("the app reloads editable comments, preserves them on save, and protects raw HTML", async () => {
  // Run the real frontend against an in-memory Tauri bridge, never a user file.
  const bundle = await Bun.build({
    entrypoints: [new URL("../src/main.ts", import.meta.url).pathname],
    target: "browser",
    format: "iife",
  });
  expect(bundle.success).toBe(true);
  const script = await bundle.outputs.find(output => output.path.endsWith(".js"))!.text();
  const dom = new JSDOM("<!doctype html><html><body><div id='editor'></div></body></html>", {
    runScripts: "outside-only",
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  let disk = "First paragraph.\n\nSecond paragraph.\n";
  const writes: string[] = [];
  // jsdom has no layout engine. Actual layout is covered by the browser check.
  (dom.window.Range.prototype as any).getClientRects = () => [];
  (dom.window.Range.prototype as any).getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  (dom.window as any).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "test" } },
    transformCallback: () => 1,
    invoke: async (command: string, args: any) => {
      if (command === "initial_path") return "/fixture.md";
      if (command === "read_file") return disk;
      if (command === "write_file") {
        writes.push(args.content);
        disk = args.content;
      }
      return 1;
    },
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  try {
    dom.window.eval(script);
    await settle();
    const editor = () => dom.window.document.querySelector(".ProseMirror")!;
    const save = async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "s", metaKey: true }));
      await settle();
    };
    expect(editor().getAttribute("contenteditable")).toBe("true");
    await save();
    expect(writes).toEqual([]);

    disk = "First paragraph.\n\n<!-- Editorial note: preserve me. -->\n\nSecond paragraph.\n";
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await settle();
    expect(editor().getAttribute("contenteditable")).toBe("true");
    expect(dom.window.document.querySelector("#badge")).toBeNull();
    expect(editor().querySelectorAll("p").length).toBe(2);
    expect(editor().querySelector("[data-html-comment]")).not.toBeNull();
    expect(dom.window.document.querySelectorAll(".comment-card").length).toBe(1);
    await save();
    expect(writes).toEqual([]);
    const instance = (editor() as any).editor;
    instance.commands.insertContent("In-memory change");
    await new Promise(resolve => setTimeout(resolve, 450));
    await save();
    expect(writes.length).toBe(1);
    expect(disk).toContain("<!-- Editorial note: preserve me. -->");

    const card = () => dom.window.document.querySelector<HTMLElement>(".comment-card")!;
    card().querySelector<HTMLButtonElement>(".comment-edit")!.click();
    const input = card().querySelector("textarea")!;
    input.value = "Updated note with <script>literal text</script>.";
    card().querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await save();
    expect(disk).toContain("<!-- Updated note with <script>literal text</script>. -->");
    expect(card().querySelector("script")).toBeNull();
    expect(card().querySelector("form")!.hidden).toBe(true);

    card().querySelector<HTMLButtonElement>(".comment-delete")!.click();
    expect(dom.window.document.querySelectorAll(".comment-card").length).toBe(0);
    expect(dom.window.document.querySelector("#document-layout.with-comments")).toBeNull();
    expect(instance.getMarkdown()).not.toContain("<!--");
    instance.commands.undo();
    expect(dom.window.document.querySelectorAll(".comment-card").length).toBe(1);
    await save();

    // New comments are drafted outside the document, then saved as a mark on the selected words.
    instance.commands.setTextSelection({ from: 1, to: 5 });
    (editor() as HTMLElement).focus();
    await new Promise(resolve => setTimeout(resolve, 40));
    const add = dom.window.document.querySelector<HTMLButtonElement>("#add-comment")!;
    expect(add.hidden).toBe(false);
    add.click();
    const draft = dom.window.document.querySelector<HTMLElement>(".comment-draft")!;
    expect(draft).not.toBeNull();
    draft.querySelector("textarea")!.value = "A new paragraph comment.";
    draft.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await save();
    expect(disk).toContain("<!-- comment: A new paragraph comment. -->");
    expect(disk).toContain("<!-- /comment -->");
    expect(dom.window.document.querySelectorAll(".comment-card").length).toBe(2);
    const writeCount = writes.length;

    disk = "<div>Unsupported raw HTML</div>\n";
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await settle();
    expect(editor().getAttribute("contenteditable")).toBe("false");
    expect(dom.window.document.querySelector("#badge")?.textContent).toContain("Read-only");
    instance.commands.insertContent("Must not save");
    await new Promise(resolve => setTimeout(resolve, 450));
    await save();
    expect(writes.length).toBe(writeCount);
    expect(disk).toBe("<div>Unsupported raw HTML</div>\n");

    disk = "First paragraph.\n\nSecond paragraph.\n";
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await settle();
    expect(editor().getAttribute("contenteditable")).toBe("true");
    expect(dom.window.document.querySelector("#badge")).toBeNull();
    await save();
    expect(writes.length).toBe(writeCount);
  } finally {
    dom.window.close();
  }
});
