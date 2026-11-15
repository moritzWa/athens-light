import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createPathCopiedToast } from "../src/toast";

test("copy confirmation fades after 1.5 seconds without taking focus or stacking", () => {
  const dom = new JSDOM("<body><input id='editor'></body>");
  const document = dom.window.document;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  dom.window.setTimeout = ((callback: () => void, delay: number) => {
    expect(delay).toBe(1500);
    timers.set(++nextTimer, callback);
    return nextTimer;
  }) as typeof dom.window.setTimeout;
  dom.window.clearTimeout = (id?: number) => { timers.delete(id!); };
  try {
    document.querySelector<HTMLInputElement>("input")!.focus();
    const focused = document.activeElement;
    const show = createPathCopiedToast(document);
    const toast = document.querySelector("[role='status']")!;
    expect(toast.textContent).toBe("");
    expect(toast.classList.contains("visible")).toBe(false);

    show();
    expect(toast.textContent).toBe("Path copied");
    expect(toast.classList.contains("visible")).toBe(true);
    expect(toast.getAttribute("aria-live")).toBe("polite");
    expect(document.activeElement).toBe(focused);

    show();
    expect(document.querySelectorAll(".toast").length).toBe(1);
    expect(timers.size).toBe(1);
    timers.values().next().value!();
    expect(toast.classList.contains("visible")).toBe(false);
    expect(document.activeElement).toBe(focused);
  } finally {
    dom.window.close();
  }
});

test("the frontend waits for the document window's copy-success event", async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL("../src/main.ts", import.meta.url).pathname],
    target: "browser",
    format: "iife",
  });
  expect(bundle.success).toBe(true);
  const script = await bundle.outputs.find(output => output.path.endsWith(".js"))!.text();
  const dom = new JSDOM("<body><div id='editor'></div></body>", {
    runScripts: "outside-only",
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  const callbacks = new Map<number, (event: unknown) => void>();
  let nextCallback = 0;
  let copied: ((event: unknown) => void) | undefined;
  (dom.window as any).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "doc-test" } },
    transformCallback: (callback: (event: unknown) => void) => {
      callbacks.set(++nextCallback, callback);
      return nextCallback;
    },
    invoke: async (command: string, args: any) => {
      if (command === "initial_path") return "/fixture.md";
      if (command === "read_file") return "A document.\n";
      if (command === "plugin:event|listen" && args.event === "path-copied") {
        expect(args.target).toEqual({ kind: "Window", label: "doc-test" });
        copied = callbacks.get(args.handler);
      }
      return 1;
    },
  };
  try {
    dom.window.eval(script);
    await new Promise(resolve => setTimeout(resolve, 10));
    const toast = dom.window.document.querySelector(".toast")!;
    expect(toast.classList.contains("visible")).toBe(false);
    expect(copied).toBeDefined();
    copied!({ event: "path-copied", payload: null });
    expect(toast.textContent).toBe("Path copied");
    expect(toast.classList.contains("visible")).toBe(true);
  } finally {
    dom.window.close();
  }
});
