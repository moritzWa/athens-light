import assert from "node:assert/strict";
import { chromium } from "playwright";

const bundle = await Bun.build({ entrypoints: [new URL("../src/main.ts", import.meta.url).pathname], target: "browser", format: "iife" });
if (!bundle.success) throw new Error("Frontend bundle failed");
const js = bundle.outputs.find(output => output.path.endsWith(".js"))!;
const css = bundle.outputs.find(output => output.path.endsWith(".css"))!;
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/app.js") return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    if (path === "/app.css") return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
    return new Response("<!doctype html><html><head><meta charset='utf-8'><link rel='stylesheet' href='/app.css'></head><body><div id='editor'></div><script src='/app.js'></script></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

const recent = [
  { path: "/Users/m/Documents/essay.md", name: "essay.md", dir: "~/Documents" },
  { path: "/Users/m/Code/blog/posts/why-we-built-a-markdown-editor-for-the-desktop.md", name: "why-we-built-a-markdown-editor-for-the-desktop.md", dir: "~/Code/blog/posts" },
  { path: "/Users/m/Downloads/notes.md", name: "notes.md", dir: "~/Downloads" },
];

const browser = await chromium.launch({ headless: true });
try {
  for (const files of [recent, []]) {
    const page = await browser.newPage({ viewport: { width: 420, height: files.length ? 472 : 300 }, colorScheme: "light" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(files => {
      const calls: { command: string; args: any }[] = [];
      (window as any).__calls = calls;
      (window as any).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "launcher" } }, transformCallback: () => 1,
        invoke: async (command: string, args: any) => {
          calls.push({ command, args });
          if (command === "initial_path") return null;
          if (command === "recent_files") return files;
          return 1;
        },
      };
    }, files);
    await page.goto(server.url.href);
    await page.getByRole("button", { name: "Open File…" }).waitFor();
    const items = page.locator("ul.recent li");
    assert.equal(await items.count(), files.length);
    if (files.length) {
      assert.deepEqual(await items.locator(".recent-name").allTextContents(), files.map(file => file.name));
      await items.nth(1).click();
      const calls = await page.evaluate(() => (window as any).__calls);
      assert.deepEqual(calls.at(-1), { command: "open_recent", args: { path: recent[1].path } });
    } else {
      assert.equal(await page.locator(".recent-title").count(), 0);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("launcher browser test passed");
} finally {
  await browser.close();
  server.stop(true);
}
