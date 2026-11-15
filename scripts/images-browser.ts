import assert from "node:assert/strict";
import { browserFixture, openContextToolbar } from "./browser-fixture";

const source = "Before the image.\n\n![Image fixture](assets/picture.png)\n\nAfter the image.";
const { page, errors, close } = await browserFixture(source);
try {
  const wrapper = page.locator(".document-image");
  const image = page.getByRole("img", { name: "Image fixture", exact: true });
  await page.waitForFunction(() => (document.querySelector(".document-image img") as HTMLImageElement)?.naturalWidth > 0);
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(() => (window as any).__fixture.writes.length), 0);
  const box = await wrapper.boundingBox();
  assert(box);
  assert.equal(await image.evaluate(element => getComputedStyle(element).pointerEvents), "none");
  assert.equal(await wrapper.evaluate(element => getComputedStyle(element).getPropertyValue("user-select") || getComputedStyle(element).getPropertyValue("-webkit-user-select")), "none");
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  assert.equal(hit, "image-selection-overlay", "the bitmap can still receive native Live Text gestures");

  await wrapper.click();
  await page.waitForFunction(() => {
    const editor = (document.querySelector(".ProseMirror") as any).editor;
    return editor.state.selection.node?.type.name === "image";
  });
  assert(await wrapper.evaluate(element => element.classList.contains("ProseMirror-selectednode")));
  const overlay = wrapper.locator(".image-selection-overlay");
  assert.notEqual(await overlay.evaluate(element => getComputedStyle(element).boxShadow), "none");
  assert.notEqual(await overlay.evaluate(element => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
  await page.screenshot({ path: new URL("../docs/image-selection.png", import.meta.url).pathname });

  // Drag across the letters painted inside the fixture image. This must remain
  // one selected image, not a text/OCR selection or a native image drag.
  await page.mouse.move(box.x + 15, box.y + 52);
  await page.mouse.down();
  await page.mouse.move(box.x + 210, box.y + 52, { steps: 8 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), "");
  assert(await page.evaluate(() => (document.querySelector(".ProseMirror") as any).editor.state.selection.node?.type.name === "image"));
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(() => (window as any).__fixture.writes.length), 0, "selecting an image scheduled a save");
  assert.equal(await page.evaluate(() => (window as any).__fixture.disk), source);

  await page.locator(".ProseMirror > p").last().click();
  await page.waitForFunction(() => !document.querySelector(".document-image")?.classList.contains("ProseMirror-selectednode"));
  assert.equal(await overlay.evaluate(element => getComputedStyle(element).boxShadow), "none");
  await wrapper.click();
  await page.keyboard.press("Backspace");
  await page.waitForFunction(() => !document.querySelector(".document-image"));
  assert.equal(await image.count(), 0);
  assert.equal(await page.locator(".ProseMirror > p").first().textContent(), "Before the image.");
  assert.equal(await page.locator(".ProseMirror > p").last().textContent(), "After the image.");
  await page.waitForFunction(() => !(window as any).__fixture.disk.includes("assets/picture.png"));
  await openContextToolbar(page);
  await page.getByRole("toolbar").getByRole("button", { name: "Undo", exact: true }).click();
  await image.waitFor();
  await page.waitForFunction(() => (window as any).__fixture.disk.includes("![Image fixture](assets/picture.png)"));
  assert.equal(await page.locator(".ProseMirror > p").first().textContent(), "Before the image.");
  assert.equal(await page.locator(".ProseMirror > p").last().textContent(), "After the image.");
  assert.deepEqual(errors, []);
  console.log("Image E2E passed: node selection, blue overlay, blocked bitmap text/drag gestures, deselection, no selection saves, delete and undo.");
} finally { await close(); }
