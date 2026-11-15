import assert from "node:assert/strict";
import { chromium } from "playwright";

const fixture = `---
title: Comment fixture
---

# Notes in the margin

A good editor lets the writing stay at the centre. Comments belong beside the paragraph, not in the middle of the prose.

<!-- This is a normal HTML comment. It stays in the Markdown file. -->

You can edit a note without changing the paragraph it refers to. Click a comment to highlight its paragraph, or select a paragraph to add another note.

<!-- Could we make this example more concrete?

Keep the explanation short. -->

Plain Markdown<!-- This inline note stays exactly here. --> still works in other editors. There is no separate database or proprietary review format.
`;

const bundle = await Bun.build({ entrypoints: [new URL("../src/main.ts", import.meta.url).pathname], target: "browser", format: "iife" });
assert(bundle.success, "frontend bundle failed");
const js = bundle.outputs.find(output => output.path.endsWith(".js"))!;
const css = bundle.outputs.find(output => output.path.endsWith(".css"))!;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/app.js") return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    if (path === "/app.css") return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
    return new Response("<!doctype html><html><head><meta charset='utf-8'><link rel='stylesheet' href='/app.css'></head><body><div id='editor'></div><script src='/app.js'></script></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 820, height: 920 }, colorScheme: "light" });
  const errors: string[] = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  await page.addInitScript(({ source }) => {
    const state = { disk: source, writes: [] as string[] };
    (window as any).__fixture = state;
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "fixture" } },
      transformCallback: () => 1,
      invoke: async (command: string, args: any) => {
        if (command === "initial_path") return "/comment-fixture.md";
        if (command === "read_file") return state.disk;
        if (command === "write_file") { state.disk = args.content; state.writes.push(args.content); }
        return 1;
      },
    };
  }, { source: fixture });
  await page.goto(server.url.href);
  try {
    await page.locator(".comment-card").nth(2).waitFor({ timeout: 10000 });
  } catch (error) {
    console.error(await page.locator("body").innerHTML());
    console.error(await page.evaluate(() => (document.querySelector(".ProseMirror") as any)?.editor?.getJSON()));
    throw error;
  }
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => (window as any).__fixture.writes.length), 0, "opening rewrote the file");
  assert.equal(await page.locator("#badge").count(), 0);
  assert.equal(await page.locator(".ProseMirror p:empty").count(), 0);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal overflow at native window width");
  const boxes = await page.locator(".comment-card").evaluateAll(cards => cards.map(card => ({ top: card.getBoundingClientRect().top, bottom: card.getBoundingClientRect().bottom })));
  for (let i = 1; i < boxes.length; i++) assert(boxes[i]!.top >= boxes[i - 1]!.bottom, "comment cards overlap");
  await page.locator(".comment-jump").first().click();
  await page.locator(".comment-anchor-active").waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: new URL("../docs/comments.png", import.meta.url).pathname, fullPage: false });

  const first = page.locator(".comment-card").first();
  await first.getByRole("button", { name: "Edit", exact: true }).click();
  await first.getByRole("textbox", { name: "Comment text" }).fill("Updated note with <script>literal text</script>.");
  await first.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => (window as any).__fixture.disk.includes("<!-- Updated note with <script>literal text</script>. -->"));
  assert.equal(await page.locator("#comments script").count(), 0);
  assert((await page.evaluate(() => (window as any).__fixture.disk)).includes("<!-- This inline note stays exactly here. -->"));

  await page.locator(".ProseMirror p").first().click({ clickCount: 3 });
  await page.getByRole("button", { name: "+ Comment", exact: true }).click();
  const draft = page.locator(".comment-draft");
  await draft.getByRole("textbox", { name: "Comment text" }).fill("Cannot close --> a comment here.");
  await draft.getByRole("button", { name: "Save", exact: true }).click();
  assert.equal(await draft.getByRole("status").textContent(), "Write a comment without <!-- or -->.");
  assert(!(await page.evaluate(() => (window as any).__fixture.disk)).includes("Cannot close"));
  await draft.getByRole("textbox", { name: "Comment text" }).fill("A new note.");
  await draft.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => (window as any).__fixture.disk.includes("<!-- A new note. -->"));
  assert.equal(await page.locator(".comment-card").count(), 4);

  await page.setViewportSize({ width: 560, height: 900 });
  await page.waitForTimeout(100);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal overflow in narrow view");
  await page.setViewportSize({ width: 1120, height: 920 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(100);
  assert(await first.isVisible());

  // External reload updates the cards without saving or duplicating notes.
  await page.evaluate(() => {
    (window as any).__fixture.disk = "External paragraph.\n\n<!-- Reloaded externally. -->\n";
    window.dispatchEvent(new Event("focus"));
  });
  await page.getByText("Reloaded externally.", { exact: true }).waitFor();
  assert.equal(await page.locator(".comment-card").count(), 1);
  assert.deepEqual(errors, [], "browser errors");
  console.log("Comments browser check passed: layout, edit, add, safe rendering, narrow/dark views, external reload.");
} finally {
  await browser?.close();
  server.stop(true);
}
