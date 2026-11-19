import assert from "node:assert/strict";
import { browserFixture } from "./browser-fixture";

const source = "# Guide\n\nHello world.\n";
const { page, errors, close } = await browserFixture(source);
const button = page.locator("#commit-button");
const panel = page.locator("#commit-panel");
const message = panel.getByRole("textbox", { name: "Commit message" });
const git = (change: (git: any) => void) => page.evaluate(`(${change.toString()})((window).__fixture.git)`);
const refresh = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));

try {
  await refresh();
  await page.waitForTimeout(100);
  assert.equal(await button.isVisible(), false, "button shown outside a git repository");

  await git(g => { g.repo = true; g.head = "# Guide\n\nHello world.\n"; });
  await refresh();
  await page.waitForTimeout(100);
  assert.equal(await button.isVisible(), false, "button shown for an unchanged file");

  await page.locator(".ProseMirror p").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" again");
  await button.waitFor();
  const box = await button.boundingBox();
  assert(box && box.x + box.width > 800 - 20 && box.y < 38, "button is not at the top right");

  // Without a model the message comes from the diff.
  await button.click();
  await panel.waitFor();
  await page.waitForFunction(() => (document.querySelector("#commit-panel textarea") as HTMLTextAreaElement).value !== "");
  assert.equal(await message.inputValue(), "Added 1 word in Guide");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
  await page.waitForFunction(() => document.querySelector(".commit-note")!.textContent === "");

  // A model message replaces the local one until the user starts typing.
  await page.keyboard.press("Escape");
  assert.equal(await panel.isVisible(), false);
  await git(g => { g.suggestion = "Extend greeting"; });
  await button.click();
  await page.waitForFunction(() => (document.querySelector("#commit-panel textarea") as HTMLTextAreaElement).value === "Extend greeting");

  // Git errors stay visible and keep the message.
  await git(g => { g.commitError = "pre-commit hook failed"; });
  await page.keyboard.press("Enter");
  await panel.locator(".commit-error").getByText("pre-commit hook failed").waitFor();
  assert.equal(await message.inputValue(), "Extend greeting");
  assert.equal(await panel.isVisible(), true);

  await git(g => { g.commitError = ""; });
  await message.fill("Extend greeting, then some");
  await panel.getByRole("button", { name: "Commit" }).click();
  await button.waitFor({ state: "hidden" });
  assert.equal(await panel.isVisible(), false);
  assert.deepEqual(await page.evaluate(() => (window as any).__fixture.git.commits), ["Extend greeting, then some"]);
  assert.equal(await page.evaluate(() => (window as any).__fixture.disk), "# Guide\n\nHello world. again\n");

  // A pending edit is written before the message is made.
  await page.keyboard.type("!");
  await button.waitFor();
  await button.click();
  await page.waitForFunction(() => (window as any).__fixture.git.info >= 2);
  assert.equal(await page.evaluate(() => (window as any).__fixture.disk.includes("again!")), true);

  // Clicking elsewhere closes the panel.
  await page.mouse.click(400, 600);
  await panel.waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log("commit browser test passed");
} finally {
  await close();
}
