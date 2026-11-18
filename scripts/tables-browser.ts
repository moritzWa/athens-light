import assert from "node:assert/strict";
import { browserFixture } from "./browser-fixture";

const fixture = `Intro paragraph.

| Name | Role |
| --- | --- |
| Ada | Engineer |
| Grace | Admiral |

After the table.
`;

const { page, errors, close } = await browserFixture(fixture);
try {
  const table = page.locator(".ProseMirror table");
  const disk = () => page.evaluate(() => (window as any).__fixture.disk as string);
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await table.waitFor();
  assert(!(await page.getByRole("button", { name: "Column options" }).isVisible()), "table controls showed before any interaction");

  await table.locator("td").first().hover();
  await frames();
  await page.getByRole("button", { name: "Column options" }).waitFor();
  await page.getByRole("button", { name: "Row options" }).waitFor();
  const cell = (await table.locator("td").first().boundingBox())!;
  const grip = (await page.getByRole("button", { name: "Column options" }).boundingBox())!;
  assert(Math.abs(grip.x - cell.x) < 2 && Math.abs(grip.width - cell.width) < 2, "column grip is not aligned with its column");
  assert(grip.y + grip.height <= (await table.boundingBox())!.y, "column grip overlaps the table");

  await page.getByRole("button", { name: "Add column" }).click();
  assert.equal(await table.locator("tr").first().locator("th").count(), 3);
  await page.waitForFunction(() => /\| Name\s+\| Role\s+\|\s+\|/.test((window as any).__fixture.disk));
  assert(!(await page.evaluate(() => (document.querySelector(".ProseMirror") as any).editor.state.selection.constructor.name)).includes("Cell"), "adding a column left the cells selected");

  await table.locator("td").first().hover();
  await frames();
  await page.getByRole("button", { name: "Add row" }).click();
  assert.equal(await table.locator("tr").count(), 4);

  await table.locator("td").nth(1).hover();
  await frames();
  await page.getByRole("button", { name: "Column options" }).click();
  assert.equal(await page.locator(".table-menu").getAttribute("aria-label"), "Column options");
  assert.equal(await page.locator(".ProseMirror .selectedCell").count(), 4, "column grip did not select the column");
  await page.getByRole("menuitem", { name: "Insert column left", exact: true }).click();
  assert.equal(await table.locator("tr").first().locator("th").count(), 4);
  assert.equal(await page.locator(".ProseMirror .selectedCell").count(), 0);

  await table.locator("td").nth(1).hover();
  await frames();
  await page.getByRole("button", { name: "Row options" }).click();
  assert(await page.getByRole("menuitem", { name: "Insert row above", exact: true }).isEnabled());
  await page.keyboard.press("Escape");
  assert(await page.locator(".table-menu").isHidden());
  await table.locator("th").first().hover();
  await frames();
  await page.getByRole("button", { name: "Row options" }).click();
  assert(await page.getByRole("menuitem", { name: "Insert row above", exact: true }).isDisabled(), "a row could be inserted above the header");
  await page.getByRole("menuitem", { name: "Insert row below", exact: true }).click();
  assert.equal(await table.locator("tr").count(), 5);

  await table.locator("tr").nth(1).locator("td").first().hover();
  await frames();
  await page.getByRole("button", { name: "Row options" }).click();
  await page.getByRole("menuitem", { name: "Delete row", exact: true }).click();
  assert.equal(await table.locator("tr").count(), 4);
  assert.equal(await table.locator("th").count(), 4, "deleting a body row changed the header");

  await table.locator("th").first().hover();
  await frames();
  await page.getByRole("button", { name: "Column options" }).click();
  await page.getByRole("menuitem", { name: "Delete column", exact: true }).click();
  assert.equal(await table.locator("tr").first().locator("th").count(), 3);

  // Dragging the border between two columns resizes the column.
  const first = table.locator("th").first();
  const before = (await first.boundingBox())!;
  await page.mouse.move(before.x + before.width - 1, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width + 59, before.y + before.height / 2, { steps: 5 });
  await page.mouse.up();
  await frames();
  const after = (await first.boundingBox())!;
  assert(after.width > before.width + 40, `column did not resize (${before.width} -> ${after.width})`);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "resizing caused page overflow");

  await first.hover();
  await frames();
  await page.getByRole("button", { name: "Column options" }).click();
  await page.getByRole("menuitem", { name: "Reset column widths", exact: true }).click();
  assert(Math.abs((await first.boundingBox())!.width - before.width) < 2, "column widths did not reset");

  await page.waitForTimeout(500);
  const saved = await disk();
  assert(/\| Role\s+\|/.test(saved) && saved.includes("| ---"), "table header lost");
  assert(saved.includes("Intro paragraph.") && saved.includes("After the table."), "surrounding text lost");

  await table.locator("th").first().hover();
  await frames();
  await page.getByRole("button", { name: "Row options" }).click();
  await page.getByRole("menuitem", { name: "Delete table", exact: true }).click();
  assert.equal(await table.count(), 0);
  await frames();
  assert(!(await page.getByRole("button", { name: "Column options" }).isVisible()), "controls stayed after deleting the table");
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForFunction(() => document.querySelectorAll(".ProseMirror table").length === 1);

  await page.setViewportSize({ width: 480, height: 800 });
  await table.locator("td").first().hover();
  await frames();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "table controls caused horizontal overflow");
  await page.waitForTimeout(600);
  await page.evaluate(() => { (window as any).__fixture.disk = "<div>Read-only fixture</div>"; window.dispatchEvent(new Event("focus")); });
  await page.getByText(/Read-only: this file/).waitFor();
  assert(!(await page.getByRole("button", { name: "Column options" }).isVisible()));
  assert.deepEqual(errors, [], "browser errors");
  console.log("Tables browser check passed: hover controls, add/insert/delete rows and columns, column resizing and reset.");
} catch (error) {
  console.error("Table failure DOM:", await page.locator(".ProseMirror").innerHTML());
  throw error;
} finally {
  await close();
}
