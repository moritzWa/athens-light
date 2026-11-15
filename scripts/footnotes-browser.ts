import assert from "node:assert/strict";
import { browserFixture, openContextToolbar } from "./browser-fixture";

const source = "Early[^beta]\n\n[^alpha]: Alpha detail.\n\nMiddle[^alpha]\n\nLast body paragraph.\n\n[^beta]: Beta detail.\n\n[^orphan]: Imported orphan content.";
const { page, errors, close } = await browserFixture(source);
const notes = page.locator(".ProseMirror > [data-footnote-definition]");
const references = page.locator(".ProseMirror > p [data-footnote-reference]");
const toolbar = page.getByRole("toolbar", { name: "Formatting and insert" });
const disk = () => page.evaluate(() => (window as any).__fixture.disk as string);
async function reload(content: string) {
  await page.waitForTimeout(500);
  await page.evaluate(content => { (window as any).__fixture.disk = content; window.dispatchEvent(new Event("focus")); }, content);
  await page.waitForTimeout(80);
}
async function clickParagraphEnd(index = 0) {
  const paragraph = page.locator(".ProseMirror > p").nth(index);
  await paragraph.evaluate(element => element.scrollIntoView({ block: "center" }));
  const box = await paragraph.boundingBox();
  await paragraph.click({ position: { x: box!.width - 2, y: box!.height / 2 } });
}
async function selectReference(index = 0) {
  const reference = references.nth(index);
  const trailing = await reference.evaluate(element => {
    let text = "";
    for (let next = element.nextSibling; next; next = next.nextSibling) text += next.textContent ?? "";
    return [...text].length;
  });
  const paragraph = reference.locator("..");
  await paragraph.evaluate(element => element.scrollIntoView({ block: "center" }));
  const box = await paragraph.boundingBox();
  await paragraph.click({ position: { x: box!.width - 2, y: box!.height / 2 } });
  for (let i = 0; i < trailing; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.waitForFunction(() => {
    const editor = (document.querySelector(".ProseMirror") as any).editor;
    return editor.state.selection.to - editor.state.selection.from === 1 && editor.state.doc.nodeAt(editor.state.selection.from)?.type.name === "footnoteReference";
  }, undefined, { timeout: 5000 });
}
async function waitReferenceCount(count: number) {
  try {
    await page.waitForFunction(count => document.querySelectorAll(".ProseMirror > p [data-footnote-reference]").length === count, count, { timeout: 5000 });
  } catch (error) {
    console.error(await page.locator(".ProseMirror").innerHTML());
    throw error;
  }
}

try {
  await notes.nth(1).waitFor();
  assert.deepEqual(await notes.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.label)), ["beta", "alpha"]);
  assert.deepEqual(await notes.locator(".footnote-number").allTextContents(), ["1", "2"]);
  assert.deepEqual(await references.locator("button").allTextContents(), ["1", "2"]);
  assert.equal(await page.locator("[data-unused-footnote]").count(), 1);
  assert(await page.evaluate(() => {
    const blocks = [...document.querySelector(".ProseMirror")!.children];
    const firstNote = blocks.findIndex(node => node.hasAttribute("data-footnote-definition"));
    return blocks.every((node, index) => !node.matches("p, h1, h2, h3") || index < firstNote);
  }), "a note was left in the middle of the body");
  await page.waitForTimeout(500);
  assert.equal(await disk(), source, "opening normalized the file on disk");
  assert.equal(await page.evaluate(() => (window as any).__fixture.writes.length), 0);
  assert(await page.locator('#editor-toolbar button[aria-label="Undo"]').isDisabled(), "opening entered undo history");
  await page.screenshot({ path: new URL("../docs/footnotes-order.png", import.meta.url).pathname });

  await clickParagraphEnd();
  await page.keyboard.insertText("!");
  await page.waitForFunction(() => (window as any).__fixture.writes.length > 0);
  const saved = await disk();
  assert(saved.indexOf("[^beta]:") < saved.indexOf("[^alpha]:"));
  assert(saved.includes("Last body paragraph."));
  assert(saved.includes("Imported orphan content."));

  await reload("Middle[^alpha]\n\nEarly[^beta]\n\n[^beta]: Beta detail.\n\n[^alpha]: Alpha detail.");
  assert.deepEqual(await notes.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.label)), ["alpha", "beta"]);
  assert.deepEqual(await references.locator("button").allTextContents(), ["1", "2"]);
  const firstNote = notes.first().locator(".footnote-content p");
  const noteBox = await firstNote.boundingBox();
  await firstNote.click({ position: { x: noteBox!.width - 2, y: noteBox!.height / 2 } });
  await page.keyboard.insertText(" Edited.");
  await page.waitForFunction(() => (window as any).__fixture.disk.includes("Alpha detail. Edited."));
  assert.equal(await notes.first().locator(".footnote-content").textContent(), "Alpha detail. Edited.");
  assert.equal(await notes.nth(1).locator(".footnote-content").textContent(), "Beta detail.");

  await reload("First[^first] second[^second]\n\n[^first]: First note.\n\n[^second]: Delete this note with its reference.");
  await selectReference(1);
  await page.keyboard.press("Backspace");
  await waitReferenceCount(1);
  assert.equal(await notes.count(), 1);
  assert.equal(await notes.locator(".footnote-content").textContent(), "First note.");
  await page.waitForFunction(() => !(window as any).__fixture.disk.includes("Delete this note"));
  assert(!(await disk()).includes("[^second]"));
  await openContextToolbar(page);
  await toolbar.getByRole("button", { name: "Undo", exact: true }).click();
  await waitReferenceCount(2);
  assert.equal(await notes.count(), 2);
  assert.deepEqual(await notes.locator(".footnote-number").allTextContents(), ["1", "2"]);
  await openContextToolbar(page);
  await toolbar.getByRole("button", { name: "Redo", exact: true }).click();
  await waitReferenceCount(1);
  assert.equal(await notes.count(), 1);
  await page.waitForTimeout(500);
  await reload((await disk()) + "\n\nExternal edit.");
  assert.equal(await notes.count(), 1, "deleted note reappeared on reload");
  assert(await page.locator('#editor-toolbar button[aria-label="Undo"]').isDisabled(), "external reload kept stale undo history");

  await reload("One[^same] two[^same]\n\n[^same]: Shared note.");
  assert.deepEqual(await references.locator("button").allTextContents(), ["1", "1"]);
  await selectReference(1);
  await page.keyboard.press("Backspace");
  await waitReferenceCount(1);
  assert.equal(await notes.count(), 1, "removing one repeated reference removed its shared note");
  await selectReference(0);
  await page.keyboard.press("Backspace");
  await waitReferenceCount(0);
  assert.equal(await notes.count(), 0, "last-reference deletion left an orphan");
  await page.waitForFunction(() => !(window as any).__fixture.disk.includes("Shared note."));

  await reload("Earlier[^first]\n\nLater[^clip]\n\n[^first]: First stays.\n\n[^clip]: Clipboard note content.");
  await selectReference(1);
  // Exercise the real editor clipboard handlers with an in-page clipboard,
  // without touching Moritz's system clipboard or calling editor commands.
  await page.locator(".ProseMirror").evaluate(root => {
    const data = new DataTransfer();
    root.dispatchEvent(new ClipboardEvent("cut", { clipboardData: data, bubbles: true, cancelable: true }));
    (window as any).__cut = { html: data.getData("text/html"), text: data.getData("text/plain") };
  });
  await waitReferenceCount(1);
  assert.equal(await notes.count(), 1);
  assert((await page.evaluate(() => (window as any).__cut.html)).includes("Clipboard note content."));
  const destination = page.locator(".ProseMirror > p").first();
  await destination.evaluate(element => element.scrollIntoView({ block: "center" }));
  const destinationBox = await destination.boundingBox();
  await destination.click({ position: { x: 0.5, y: destinationBox!.height / 2 } });
  await page.waitForFunction(() => {
    const editor = (document.querySelector(".ProseMirror") as any).editor;
    return editor.state.selection.empty && editor.state.selection.from === editor.view.posAtDOM(document.querySelector(".ProseMirror > p"), 0);
  });
  await page.locator(".ProseMirror").evaluate(root => {
    const data = new DataTransfer();
    data.setData("text/html", (window as any).__cut.html);
    data.setData("text/plain", (window as any).__cut.text);
    root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await waitReferenceCount(2);
  assert.equal(await notes.count(), 2);
  assert.deepEqual(await references.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.label)), ["clip", "first"]);
  assert.deepEqual(await notes.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.label)), ["clip", "first"]);
  assert.deepEqual(await references.locator("button").allTextContents(), ["1", "2"]);
  assert.equal(await notes.first().locator(".footnote-content").textContent(), "Clipboard note content.");
  await openContextToolbar(page);
  await toolbar.getByRole("button", { name: "Undo", exact: true }).click();
  await waitReferenceCount(1);
  assert.equal(await notes.count(), 1);
  await openContextToolbar(page);
  await toolbar.getByRole("button", { name: "Redo", exact: true }).click();
  await waitReferenceCount(2);
  assert.deepEqual(await notes.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.label)), ["clip", "first"]);

  await reload("Paragraph to annotate.\n\n[^1]: Imported orphan source.");
  assert.equal(await notes.count(), 0);
  assert.equal(await page.locator("[data-unused-footnote]").count(), 1);
  await clickParagraphEnd();
  await openContextToolbar(page);
  await toolbar.getByRole("button", { name: "Footnote", exact: true }).click();
  await page.keyboard.insertText("New numbered note.");
  await page.waitForFunction(() => (window as any).__fixture.disk.includes("[^2]: New numbered note."));
  assert.deepEqual(await notes.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.label)), ["2"]);
  assert.deepEqual(await references.locator("button").allTextContents(), ["1"]);
  assert((await disk()).includes("[^1]: Imported orphan source."));
  await page.screenshot({ path: new URL("../docs/footnotes-behavior.png", import.meta.url).pathname });
  assert.deepEqual(errors, []);
  console.log("Footnote E2E passed: collected/order, renumbering, editing, last-reference deletion, repeated refs, undo/redo, cut/paste, orphan preservation, reload, and label collisions.");
} finally { await close(); }
