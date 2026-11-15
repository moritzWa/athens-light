import assert from "node:assert/strict";
import { browserFixture, openContextToolbar } from "./browser-fixture";

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

const { page, errors, close } = await browserFixture(fixture);
try {
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
  assert.equal(await page.locator("#selection-actions").count(), 0);
  assert(!(await page.getByRole("toolbar", { name: "Formatting and insert" }).isVisible()));
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
  await page.getByRole("button", { name: "Comment", exact: true }).click();
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
  await openContextToolbar(page);
  await page.getByRole("button", { name: "Footnote", exact: true }).click();
  await page.keyboard.insertText("A new footnote.");
  await page.waitForFunction(() => (window as any).__fixture.disk.includes("[^1]: A new footnote."));
  assert.equal(await page.locator("[data-footnote-reference]").count(), 2);
  assert.equal(await page.locator("[data-footnote-definition]").count(), 2);
  await page.screenshot({ path: new URL("../docs/footnotes.png", import.meta.url).pathname });

  await page.evaluate(() => {
    (window as any).__fixture.disk = "# Toolbar fixture\n\nA plain selected phrase.\n\nAnother paragraph.";
    window.dispatchEvent(new Event("focus"));
  });
  await page.getByRole("heading", { name: "Toolbar fixture" }).waitFor();
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 820, height: 920 });
  const toolbar = page.getByRole("toolbar", { name: "Formatting and insert" });
  assert(!(await toolbar.isVisible()), "toolbar should be hidden before selection");
  const selectionWrites = await page.evaluate(() => (window as any).__fixture.writes.length);
  async function selectFirstParagraph() {
    const paragraph = page.locator(".ProseMirror > p").first();
    await paragraph.evaluate(element => element.scrollIntoView({ block: "center" }));
    const paragraphBox = await paragraph.boundingBox();
    // Clear the previous highlight first, otherwise dragging inside it starts a
    // native text drag/drop rather than a fresh text selection.
    await paragraph.click({ position: { x: paragraphBox!.width - 2, y: paragraphBox!.height / 2 } });
    const bounds = await paragraph.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(bounds.left + 0.5, bounds.y);
    await page.mouse.down();
    await page.mouse.move(bounds.right + 0.5, bounds.y, { steps: 8 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), "A plain selected phrase.");
  }
  await selectFirstParagraph();
  assert.equal(await page.locator("#selection-actions").count(), 0);
  await toolbar.waitFor();
  const menuBox = (await toolbar.boundingBox())!;
  assert(menuBox.width <= 280 && menuBox.x >= 12 && menuBox.y > 38, "selection menu was not compact and viewport-contained");
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(() => (window as any).__fixture.writes.length), selectionWrites, "showing selection menu saved the document");
  await page.screenshot({ path: new URL("../docs/toolbar.png", import.meta.url).pathname });
  await page.keyboard.press("Escape");
  assert(!(await toolbar.isVisible()), "Escape did not dismiss selection menu");
  await selectFirstParagraph();
  await toolbar.waitFor();
  await toolbar.getByRole("button", { name: "Bold", exact: true }).click();
  assert.equal(await page.locator(".ProseMirror strong").textContent(), "A plain selected phrase.");
  await page.waitForFunction(() => document.querySelector('#editor-toolbar button[aria-label="Bold"]')?.getAttribute("aria-pressed") === "true", undefined, { timeout: 5000 });
  await toolbar.getByRole("button", { name: "Italic", exact: true }).click();
  assert.equal(await page.locator(".ProseMirror em").textContent(), "A plain selected phrase.");
  await toolbar.getByRole("combobox", { name: "Text style" }).selectOption("heading2");
  await page.getByRole("heading", { name: "A plain selected phrase." }).waitFor();
  await toolbar.getByRole("combobox", { name: "Text style" }).selectOption("paragraph");
  await toolbar.getByRole("button", { name: "Lists", exact: true }).click();
  await page.getByRole("menuitem", { name: "Bullet list", exact: true }).click();
  assert.equal(await page.locator(".ProseMirror ul li").textContent(), "A plain selected phrase.");
  await toolbar.getByRole("button", { name: "Lists", exact: true }).click();
  await page.getByRole("menuitem", { name: "Bullet list", exact: true }).click();
  await selectFirstParagraph();
  await toolbar.getByRole("button", { name: "Link", exact: true }).click();
  const insertLink = page.getByRole("dialog", { name: "Insert link", exact: true });
  assert.equal(await insertLink.getByRole("textbox", { name: "Link text", exact: true }).inputValue(), "A plain selected phrase.");
  await insertLink.getByRole("textbox", { name: "Link URL", exact: true }).fill("https://example.com/toolbar");
  await insertLink.getByRole("button", { name: "Insert", exact: true }).click();
  try {
    await page.getByRole("link", { name: "A plain selected phrase.", exact: true }).waitFor({ timeout: 5000 });
  } catch (error) {
    console.error(await page.locator(".ProseMirror").innerHTML());
    console.error(await page.locator(".toolbar-panel").innerHTML());
    console.error(await page.evaluate(() => ({ from: (document.querySelector(".ProseMirror") as any).editor.state.selection.from, to: (document.querySelector(".ProseMirror") as any).editor.state.selection.to })));
    throw error;
  }
  assert.equal(await page.locator(".ProseMirror strong").textContent(), "A plain selected phrase.");

  await page.locator(".ProseMirror > p").last().click();
  await page.waitForFunction(() => (document.querySelector("#editor-toolbar") as HTMLElement).hidden);
  await openContextToolbar(page);
  await toolbar.getByRole("button", { name: "Image", exact: true }).click();
  const imageDialog = page.getByRole("dialog", { name: "Insert image", exact: true });
  await imageDialog.getByRole("button", { name: "Choose file…", exact: true }).click();
  assert.equal(await imageDialog.getByRole("textbox", { name: "Image URL or path", exact: true }).inputValue(), "assets/my%20photo.png");
  await imageDialog.getByRole("textbox", { name: "Alternative text", exact: true }).fill("A [bracket] photo");
  await imageDialog.getByRole("button", { name: "Insert", exact: true }).click();
  await page.waitForFunction(() => (document.querySelector(".ProseMirror img") as HTMLImageElement)?.naturalWidth > 0);
  await page.waitForFunction(() => (window as any).__fixture.disk.includes("assets/my%20photo.png"));
  assert.equal(await page.getByRole("img", { name: "A [bracket] photo", exact: true }).count(), 1);

  await page.locator(".ProseMirror > p").last().click();
  await openContextToolbar(page);
  await toolbar.getByRole("button", { name: "Table", exact: true }).click();
  const insertTable = page.getByRole("dialog", { name: "Insert table", exact: true });
  await insertTable.getByRole("spinbutton", { name: "Rows", exact: true }).fill("3");
  await insertTable.getByRole("spinbutton", { name: "Columns", exact: true }).fill("2");
  await insertTable.getByRole("button", { name: "Insert", exact: true }).click();
  const table = page.locator(".ProseMirror table");
  assert.equal(await table.locator("tr").count(), 3);
  assert.equal(await table.locator("tr").first().locator("th").count(), 2);
  await table.locator("th").first().click();
  await page.keyboard.insertText("Header");
  await openContextToolbar(page);
  await toolbar.getByRole("button", { name: "Table", exact: true }).click();
  await page.getByRole("menuitem", { name: "Insert row below", exact: true }).click();
  assert.equal(await table.locator("tr").count(), 4);
  await table.locator("tr").nth(1).locator("td").first().click();
  await page.waitForFunction(() => (document.querySelector(".ProseMirror") as any).editor.state.selection.$from.node(-1).type.name === "tableCell");
  await openContextToolbar(page);
  await toolbar.getByRole("button", { name: "Table", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete row", exact: true }).click();
  assert.equal(await table.locator("tr").count(), 3);
  assert.equal(await table.locator("th").count(), 2, "deleting a body row removed the table header");
  await table.locator("th").first().click();
  await openContextToolbar(page);
  await toolbar.getByRole("button", { name: "Table", exact: true }).click();
  await page.getByRole("menuitem", { name: "Insert column right", exact: true }).click();
  assert.equal(await table.locator("tr").first().locator("th").count(), 3);
  await table.locator("th").nth(1).click();
  await openContextToolbar(page);
  await toolbar.getByRole("button", { name: "Table", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete column", exact: true }).click();
  assert.equal(await table.locator("tr").first().locator("th").count(), 2);
  await openContextToolbar(page);
  await toolbar.getByRole("button", { name: "Table", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete table", exact: true }).click();
  assert.equal(await table.count(), 0);
  await openContextToolbar(page);
  await toolbar.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await table.count(), 1);
  await page.waitForTimeout(500);
  const saved = await page.evaluate(() => (window as any).__fixture.disk);
  assert(saved.includes("A plain selected phrase."), "toolbar removed the selected prose");
  assert(saved.includes("Header"), "table actions lost the existing header");
  assert(saved.includes("![A \\[bracket\\] photo](assets/my%20photo.png)"), "image did not stay standard Markdown");
  await page.evaluate(() => {
    const state = (window as any).__fixture;
    state.disk += "\nExternal paragraph.\n";
    window.dispatchEvent(new Event("focus"));
  });
  await page.getByText("External paragraph.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("img", { name: "A [bracket] photo", exact: true }).count(), 1);
  assert.equal(await table.count(), 1);
  await page.setViewportSize({ width: 480, height: 800 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "toolbar caused horizontal page overflow");
  await page.evaluate(() => { (window as any).__fixture.disk = "<div>Read-only fixture</div>"; window.dispatchEvent(new Event("focus")); });
  await page.getByText(/Read-only: this file/).waitFor();
  await page.waitForFunction(() => (document.querySelector('#editor-toolbar button[aria-label="Image"]') as HTMLButtonElement)?.disabled);
  assert(!(await toolbar.isVisible()), "read-only document showed formatting menu");
  assert.deepEqual(errors, [], "browser errors");
  console.log("Editor browser check passed: contextual toolbar, formatting, image import, table editing, comments, footnotes, links, and external reload.");
} catch (error) {
  console.error("Editor failure DOM:", await page.locator(".ProseMirror").innerHTML());
  console.error("Editor failure selection:", await page.evaluate(() => (document.querySelector(".ProseMirror") as any).editor.state.selection.toJSON()));
  throw error;
} finally {
  await close();
}
