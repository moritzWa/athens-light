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
    const state = { disk: source, writes: [] as string[], opens: [] as string[], copies: [] as string[] };
    (window as any).__fixture = state;
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { state.copies.push(text); } } });
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "fixture" } },
      transformCallback: () => 1,
      invoke: async (command: string, args: any) => {
        if (command === "initial_path") return "/comment-fixture.md";
        if (command === "read_file") return state.disk;
        if (command === "write_file") { state.disk = args.content; state.writes.push(args.content); }
        if (command === "open_url") state.opens.push(args.url);
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

  const beforeFootnotes = await page.evaluate(() => (window as any).__fixture.writes.length);
  await page.evaluate(() => {
    (window as any).__fixture.disk = "A [**linked phrase**](https://example.com/original) and a note[^source].\n\n[^source]: The **editable** footnote with [a source](https://example.org).\n";
    window.dispatchEvent(new Event("focus"));
  });
  await page.locator("[data-footnote-definition]").waitFor();
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(() => (window as any).__fixture.writes.length), beforeFootnotes, "loading footnotes rewrote the file");
  assert.equal(await page.locator("#badge").count(), 0);
  const link = page.locator(".ProseMirror a").first();
  assert.equal(await link.evaluate(element => getComputedStyle(element).cursor), "pointer");
  await link.click();
  await page.waitForFunction(() => (window as any).__fixture.opens.includes("https://example.com/original"));
  await link.hover();
  const popover = page.getByRole("dialog", { name: "Link", exact: true });
  await popover.waitFor();
  await popover.getByRole("button", { name: "Copy link", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).__fixture.copies), ["https://example.com/original"]);
  await popover.getByRole("button", { name: "Edit", exact: true }).click();
  await popover.getByRole("textbox", { name: "Link URL", exact: true }).fill("javascript:alert(1)");
  await popover.getByRole("button", { name: "Save", exact: true }).click();
  assert(await popover.getByText("Enter link text and an http, https or mailto URL.").isVisible());
  await popover.getByRole("textbox", { name: "Link URL", exact: true }).fill("https://example.net/updated");
  await popover.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => (window as any).__fixture.disk.includes("https://example.net/updated"));
  assert.equal(await page.locator(".ProseMirror strong").first().textContent(), "linked phrase");
  await link.hover();
  await popover.getByRole("button", { name: "Edit", exact: true }).click();
  await popover.getByRole("textbox", { name: "Link text", exact: true }).fill("Updated label");
  await popover.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("link", { name: "Updated label", exact: true }).waitFor();
  await page.getByRole("link", { name: "Updated label", exact: true }).hover();
  await page.screenshot({ path: new URL("../docs/link-popover.png", import.meta.url).pathname });
  await popover.getByRole("button", { name: "Edit", exact: true }).click();
  await popover.getByRole("button", { name: "Remove link", exact: true }).click();
  assert.equal(await page.getByRole("link", { name: "Updated label", exact: true }).count(), 0);
  assert.equal(await page.locator(".ProseMirror strong").first().textContent(), "Updated label");

  await page.locator("[data-footnote-reference] button").first().click();
  assert(await page.evaluate(() => {
    const from = (document.querySelector(".ProseMirror") as any).editor.state.selection.$from;
    return Array.from({ length: from.depth }, (_, i) => from.node(i + 1).type.name).includes("footnoteDefinition");
  }), "reference did not jump into the footnote");
  await page.locator(".footnote-number").first().click();
  assert.equal(await page.evaluate(() => (document.querySelector(".ProseMirror") as any).editor.state.selection.$from.parent.type.name), "paragraph");
  const note = page.locator(".footnote-content p").first();
  await note.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" Edited.");
  await page.waitForFunction(() => (window as any).__fixture.disk.includes("Edited."));
  assert((await page.evaluate(() => (window as any).__fixture.disk)).includes("[^source]:"));
  await page.locator(".ProseMirror > p").first().click({ clickCount: 3 });
  await page.getByRole("button", { name: "+ Footnote", exact: true }).click();
  await page.keyboard.insertText("A new footnote.");
  await page.waitForFunction(() => (window as any).__fixture.disk.includes("[^1]: A new footnote."));
  assert.equal(await page.locator("[data-footnote-reference]").count(), 2);
  assert.equal(await page.locator("[data-footnote-definition]").count(), 2);
  await page.screenshot({ path: new URL("../docs/footnotes.png", import.meta.url).pathname });
  assert.deepEqual(errors, [], "browser errors");
  console.log("Editor browser check passed: comments, footnotes, link opening/copy/edit/remove, safe URLs, and external reload.");
} finally {
  await browser?.close();
  server.stop(true);
}
