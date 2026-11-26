import assert from "node:assert/strict";
import { browserFixture } from "./browser-fixture";

const short = "Alpha beta gamma delta. Second sentence here.\n\nThird paragraph is short.";
const long = Array.from({ length: 8 }, (_, index) => `Paragraph ${index + 1} has several plain words, so the reading needs more than one piece of speech.`).join("\n\n");
const { page, errors, close } = await browserFixture(short);
const controls = page.locator(".speech-controls");
// The marks are shapes behind the text, tagged with the text they cover.
const word = page.locator(".speech-marks .word[data-text]");
const sentence = page.locator(".speech-marks .sentence[data-text]");
const calls = () => page.evaluate(() => (window as any).__fixture.speech as { text: string; language: string }[]);
const writes = () => page.evaluate(() => (window as any).__fixture.writes.length as number);
const wordText = async () => (await word.count()) ? await word.getAttribute("data-text") : "";
async function waitWord(expected: string) {
  try {
    await page.waitForFunction(expected => document.querySelector(".speech-marks .word[data-text]")?.getAttribute("data-text") === expected, expected, { timeout: 8000 });
  } catch (error) {
    throw new Error(`Expected highlighted word ${expected}, saw ${JSON.stringify(await wordText())}; calls ${JSON.stringify(await calls())}; state ${await controls.getAttribute("data-state")} ${await controls.textContent()}`);
  }
}
async function pointAt(needle: string) {
  return page.evaluate(needle => {
    const walker = document.createTreeWalker(document.querySelector(".ProseMirror")!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at + 1);
      range.setEnd(node, at + 2);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    throw new Error(`No text ${needle}`);
  }, needle);
}
async function setSelection(from: number, to: number) {
  await page.evaluate(({ from, to }) => {
    const editor = (document.querySelector(".ProseMirror") as any).editor;
    editor.commands.setTextSelection({ from, to });
    editor.commands.focus();
  }, { from, to });
}
async function docPosition(needle: string) {
  return page.evaluate(needle => {
    const editor = (document.querySelector(".ProseMirror") as any).editor;
    let found = -1;
    editor.state.doc.descendants((node: any, pos: number) => {
      const at = node.isText ? node.text.indexOf(needle) : -1;
      if (found < 0 && at >= 0) found = pos + at;
    });
    return found;
  }, needle);
}

try {
  assert.equal(await controls.isHidden(), true, "controls are hidden until reading starts");

  // Cmd+S reads from the caret, highlighting the sentence and the spoken word.
  await page.locator(".ProseMirror").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Meta+s");
  await controls.waitFor({ state: "visible" });
  await waitWord("Alpha");
  assert.equal(await sentence.getAttribute("data-text"), "Alpha beta gamma delta.");
  await waitWord("beta");
  assert.deepEqual((await calls()).map(call => call.language), ["en"]);
  assert((await calls())[0].text.startsWith("Alpha beta gamma delta. Second sentence here. Third paragraph is short."));
  assert.equal(await writes(), 0, "reading rewrote the document");

  // Cmd+S again pauses on the same word, and once more resumes.
  await page.keyboard.press("Meta+s");
  await page.getByRole("button", { name: "Resume" }).waitFor();
  const paused = await wordText();
  await page.waitForTimeout(500);
  assert.equal(await wordText(), paused, "the highlight moved while paused");
  await page.keyboard.press("Meta+s");
  await page.getByRole("button", { name: "Pause" }).waitFor();
  await page.waitForFunction(before => document.querySelector(".speech-marks .word")?.getAttribute("data-text") !== before, paused, { timeout: 8000 });

  // Speed keys and buttons change and remember the rate.
  assert.equal(await page.locator(".speech-rate").textContent(), "1.7×");
  await page.keyboard.press("Alt+Equal");
  assert.equal(await page.locator(".speech-rate").textContent(), "1.8×");
  await page.getByRole("button", { name: "Slower" }).click();
  await page.getByRole("button", { name: "Slower" }).click();
  assert.equal(await page.locator(".speech-rate").textContent(), "1.6×");
  assert.equal(await page.evaluate(() => localStorage.getItem("athens-light.speech-rate")), "1.6");

  // Escape stops and clears the highlight.
  await page.keyboard.press("Escape");
  await controls.waitFor({ state: "hidden" });
  assert.equal(await word.count(), 0);
  assert.equal(await sentence.count(), 0);

  // A selection reads just the selection.
  const before = (await calls()).length;
  const from = await docPosition("Second");
  await setSelection(from, from + "Second sentence here.".length);
  await page.keyboard.press("Meta+s");
  await waitWord("Second");
  assert.equal((await calls())[before].text, "Second sentence here.");
  await page.keyboard.press("Escape");

  // Option+click reads from the clicked word, and jumps there while reading.
  const click = await pointAt("Third");
  await page.keyboard.down("Alt");
  await page.mouse.click(click.x, click.y);
  await page.keyboard.up("Alt");
  await waitWord("Third");
  assert((await calls()).at(-1)!.text.startsWith("Third paragraph"));
  assert.equal(await page.evaluate(() => (document.querySelector(".ProseMirror") as any).editor.state.selection.from), from, "Option+click moved the selection");

  // Option+click entered reader mode, where a plain click reads from the word and leaves the caret alone.
  assert.equal(await controls.isVisible(), true, "controls are visible in reader mode");
  assert.equal(await page.evaluate(() => document.body.classList.contains("reader-mode")), true);
  // Hovering previews the sentence a click would read from; the click starts at its beginning.
  const gamma = await pointAt("gamma");
  await page.mouse.move(gamma.x, gamma.y);
  await page.waitForFunction(() => document.querySelector(".speech-marks .hover")?.getAttribute("data-text") === "Alpha beta gamma delta.", undefined, { timeout: 5000 });
  await page.mouse.click(gamma.x, gamma.y);
  await waitWord("Alpha");
  assert((await calls()).at(-1)!.text.startsWith("Alpha beta gamma delta."), "a click in reader mode did not read from the start of the sentence");
  assert.equal(await page.locator(".speech-marks .hover[data-text]").count(), 0, "the hover preview stayed on the sentence being read");
  assert.equal(await page.evaluate(() => (document.querySelector(".ProseMirror") as any).editor.state.selection.from), from, "a click in reader mode moved the caret");

  // Escape leaves reader mode; then a click places the caret and reads nothing.
  await page.keyboard.press("Escape");
  await controls.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.body.classList.contains("reader-mode")), false);
  assert.equal(await page.locator(".speech-marks .hover[data-text]").count(), 0, "hover preview outlived reader mode");
  const readsBefore = (await calls()).length;
  const third = await pointAt("Third");
  await page.mouse.click(third.x, third.y);
  await page.waitForTimeout(300);
  assert.notEqual(await page.evaluate(() => (document.querySelector(".ProseMirror") as any).editor.state.selection.from), from, "click did not place the caret after leaving reader mode");
  assert.equal((await calls()).length, readsBefore, "a click outside reader mode started reading");
  assert.equal(await controls.isHidden(), true);

  // Typing makes the script stale, so it stops reading instead of highlighting the wrong words.
  await page.keyboard.press("Meta+s");
  await controls.waitFor({ state: "visible" });
  await page.keyboard.insertText("x");
  await controls.waitFor({ state: "hidden" });
  assert.equal(await word.count(), 0);

  // A failed request is shown, and nothing is left playing.
  await page.evaluate(() => { (window as any).__fixture.speechError = "Add a Speechify API key"; });
  await page.keyboard.press("Meta+s");
  await page.getByText("Add a Speechify API key").waitFor();
  await page.keyboard.press("Escape");
  await page.evaluate(() => { (window as any).__fixture.speechError = ""; });

  // A long document is read in several pieces, ahead of playback, to the end.
  await page.evaluate(() => localStorage.setItem("athens-light.speech-rate", "3"));
  await page.reload();
  await page.locator(".ProseMirror").waitFor();
  await page.evaluate(source => { (window as any).__fixture.disk = source; window.dispatchEvent(new Event("focus")); }, long);
  await page.locator(".ProseMirror p").nth(7).waitFor();
  await page.locator(".ProseMirror").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Meta+s");
  await page.waitForFunction(() => {
    const mark = document.querySelector(".speech-marks .word[data-text]")?.getBoundingClientRect();
    const paragraph = document.querySelectorAll(".ProseMirror p")[7]?.getBoundingClientRect();
    return !!mark && !!paragraph && mark.top >= paragraph.top - 4 && mark.bottom <= paragraph.bottom + 4;
  }, undefined, { timeout: 30000 });
  // The reading ends, but reader mode stays on so a click can start another one.
  await page.waitForFunction(() => document.querySelector(".speech-controls")?.getAttribute("data-state") === "ready", undefined, { timeout: 30000 });
  assert.equal(await controls.isVisible(), true);
  assert.equal(await page.evaluate(() => document.body.classList.contains("reader-mode")), true);
  const pieces = await calls();
  assert(pieces.length >= 2, "expected the long text to be split into pieces");
  assert.equal(pieces.map(piece => piece.text).join("").trim(), long.split("\n\n").join(" "), "pieces did not cover the text exactly");
  assert.equal(await word.count(), 0, "highlight remained after the reading ended");
  const again = await pointAt("Paragraph 5");
  await page.mouse.click(again.x, again.y);
  await page.waitForFunction(() => document.querySelector(".speech-controls")?.getAttribute("data-state") !== "ready");
  assert((await calls()).at(-1)!.text.startsWith("Paragraph 5"), "clicking after a reading ended did not start another");
  await page.keyboard.press("Escape");
  await controls.waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log("speech browser checks passed");
} finally {
  await close();
}
