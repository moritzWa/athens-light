import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

test("the app reloads comments read-only and never writes the external file", async () => {
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
  (dom.window as any).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "test" } },
    transformCallback: () => 1,
    invoke: async (command: string, args: any) => {
      if (command === "initial_path") return "/fixture.md";
      if (command === "read_file") return disk;
      if (command === "write_file") writes.push(args.content);
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
    expect(editor().getAttribute("contenteditable")).toBe("false");
    expect(dom.window.document.querySelector("#badge")?.textContent).toContain("Read-only");
    expect(editor().querySelectorAll("p").length).toBe(2);
    expect(editor().querySelector("[data-html-comment]")).not.toBeNull();
    // Even an API-triggered update must not bypass the read-only write guard.
    const instance = (editor() as any).editor;
    instance.commands.insertContent("In-memory change");
    await new Promise(resolve => setTimeout(resolve, 450));
    await save();
    expect(writes).toEqual([]);
    expect(disk).toContain("<!-- Editorial note: preserve me. -->");

    disk = "First paragraph.\n\nSecond paragraph.\n";
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await settle();
    expect(editor().getAttribute("contenteditable")).toBe("true");
    expect(dom.window.document.querySelector("#badge")).toBeNull();
    await save();
    expect(writes).toEqual([]);
  } finally {
    dom.window.close();
  }
});
