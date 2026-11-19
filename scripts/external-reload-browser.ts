import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rename, unlink, utimes, symlink, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserFixture } from "./browser-fixture";

const directory = await mkdtemp(join(tmpdir(), "athens-text-reload-"));
const file = join(directory, "note.md");
const original = "# Outline\n\nFirst paragraph.\n\nSecond paragraph.\n\nLast paragraph.\n";
const fixtures: (() => Promise<void>)[] = [];

// Everything below happens without the window ever gaining focus: the app has to notice by itself.
const text = (page: any) => page.evaluate(() => (document.querySelector(".ProseMirror") as any).innerText.replace(/\n+/g, "\n").trim());
const shows = (page: any, expected: string) => page.waitForFunction((expected: string) => (document.querySelector(".ProseMirror") as any).innerText.includes(expected), expected, { timeout: 4000 });
const fixtureState = (page: any) => page.evaluate(() => (window as any).__fixture);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: directory, stdio: "pipe" });

try {
  await writeFile(file, original);
  const fixture = await browserFixture(original, directory, file);
  fixtures.push(fixture.close);
  const { page, errors } = fixture;
  await shows(page, "Last paragraph.");

  // The reader's place survives: caret in the last paragraph, a change above it.
  await page.getByText("Last paragraph.").click();
  await page.keyboard.press("End");
  await page.waitForTimeout(600);
  const caretText = () => page.evaluate(() => {
    const editor = (document.querySelector(".ProseMirror") as any).editor;
    const { $from } = editor.state.selection;
    return { text: $from.parent.textContent, offset: $from.parentOffset };
  });
  assert.deepEqual(await caretText(), { text: "Last paragraph.", offset: 15 });

  await writeFile(file, original.replace("First paragraph.", "First paragraph, rewritten by overwrite."));
  await shows(page, "rewritten by overwrite");
  assert.deepEqual(await caretText(), { text: "Last paragraph.", offset: 15 }, "caret moved on external reload");

  await writeFile(join(directory, "note.tmp"), original.replace("First paragraph.", "First paragraph via rename."));
  await rename(join(directory, "note.tmp"), file);
  await shows(page, "First paragraph via rename.");

  await writeFile(file, "");
  await sleep(1300);
  await writeFile(file, original.replace("First paragraph.", "First paragraph after truncate."));
  await shows(page, "First paragraph after truncate.");

  await unlink(file);
  await sleep(1300);
  await writeFile(file, original.replace("First paragraph.", "First paragraph recreated."));
  await shows(page, "First paragraph recreated.");

  // Replacing the file with a longer or shorter one in the same second still counts.
  const now = new Date();
  await writeFile(file, original.replace("First paragraph.", "First paragraph, same size A."));
  await utimes(file, now, now);
  await shows(page, "same size A.");
  await writeFile(file, original.replace("First paragraph.", "First paragraph, same size B."));
  await utimes(file, now, now);
  await shows(page, "same size B.");

  // A touch changes nothing: no reload, no write.
  const before = await page.evaluate(() => JSON.stringify((document.querySelector(".ProseMirror") as any).editor.getJSON()));
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  await sleep(2200);
  assert.equal(await page.evaluate(() => JSON.stringify((document.querySelector(".ProseMirror") as any).editor.getJSON())), before);

  // Reloading is not an edit: no echo writes, no undo history, no read-only fallout.
  assert.deepEqual((await fixtureState(page)).writes, [], "external reload was written back to disk");
  assert.equal(await page.evaluate(() => (document.querySelector(".ProseMirror") as any).editor.can().undo()), false);
  assert.equal(await page.locator("#external-conflict").count(), 0);

  // An edit of the user's own still saves, and its echo does not reload or conflict.
  await page.getByText("Second paragraph.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Mine.");
  await page.waitForFunction(() => (window as any).__fixture.writes.length === 1);
  assert((await readFile(file, "utf8")).includes("Second paragraph. Mine."));
  await sleep(2200);
  assert.equal(await page.locator("#external-conflict").count(), 0);
  assert.equal((await fixtureState(page)).writes.length, 1);
  assert((await text(page)).includes("Second paragraph. Mine."));

  // Unsaved edits are never silently discarded: an external write that lands before the autosave raises a choice.
  const mine = "Second paragraph. Mine. More mine.";
  await page.keyboard.type(" More mine.");
  await writeFile(file, original.replace("Second paragraph.", "Second paragraph. THEIRS."));
  const conflict = page.locator("#external-conflict");
  await conflict.waitFor({ timeout: 4000 });
  assert.equal(await conflict.getAttribute("role"), "alert");
  await sleep(900);
  assert((await readFile(file, "utf8")).includes("THEIRS."), "autosave overwrote the external version");
  assert((await text(page)).includes(mine), "unsaved edit was discarded");
  assert.equal((await fixtureState(page)).writes.length, 1, "autosave ran during a conflict");

  // Keep both: their version is shown, mine is kept beside it.
  await conflict.getByRole("button", { name: "Keep both" }).click();
  await shows(page, "THEIRS.");
  await page.waitForFunction(() => (window as any).__fixture.sideFiles.length === 1);
  const side = (await fixtureState(page)).sideFiles[0];
  assert.match(side.path, /note \(my edits [\d-]+ [\d.]+\)\.md$/);
  assert(side.content.includes(mine));
  assert.equal(await conflict.count(), 0);
  assert((await readFile(file, "utf8")).includes("THEIRS."));

  // Take theirs.
  await page.getByText("Second paragraph.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Second try.");
  await writeFile(file, original.replace("Second paragraph.", "Second paragraph. THEIRS AGAIN."));
  await conflict.waitFor({ timeout: 4000 });
  await conflict.getByRole("button", { name: "Take theirs" }).click();
  await shows(page, "THEIRS AGAIN.");
  assert(!(await text(page)).includes("Second try."));
  await sleep(900);
  assert((await readFile(file, "utf8")).includes("THEIRS AGAIN."));
  assert.equal((await fixtureState(page)).sideFiles.length, 1);

  // Keep mine: the user's text goes to disk, then autosave resumes.
  await page.getByText("Second paragraph.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Third try.");
  await writeFile(file, original.replace("Second paragraph.", "Second paragraph. THEIRS THIRD."));
  await conflict.waitFor({ timeout: 4000 });
  await conflict.getByRole("button", { name: "Keep mine" }).click();
  await page.waitForFunction(() => (window as any).__fixture.disk.includes("Third try."));
  assert((await readFile(file, "utf8")).includes("Third try."));
  assert(!(await readFile(file, "utf8")).includes("THEIRS THIRD"));
  await page.getByText("Second paragraph.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Fourth.");
  await page.waitForFunction(() => (window as any).__fixture.disk.includes("Fourth."));
  assert.equal(await conflict.count(), 0);
  assert.deepEqual(errors, []);

  // Git rewrites files by unlinking and recreating them (checkout), inside a repository.
  git("init", "-q");
  await writeFile(file, "# Outline\n\nCommitted v1.\n");
  git("add", "note.md"); git("commit", "-qm", "v1");
  await writeFile(file, "# Outline\n\nCommitted v2.\n");
  git("commit", "-qam", "v2");
  await shows(page, "Committed v2.");
  git("checkout", "-q", "HEAD~1", "--", "note.md");
  await shows(page, "Committed v1.");
  git("checkout", "-q", "HEAD", "--", "note.md");
  await shows(page, "Committed v2.");

  // A document opened through a symlink follows changes to its target.
  const real = join(directory, "real");
  await mkdir(real);
  await writeFile(join(real, "target.md"), "Linked v1.\n");
  await symlink(join(real, "target.md"), join(directory, "link.md"));
  const linked = await browserFixture("Linked v1.\n", directory, join(directory, "link.md"));
  fixtures.push(linked.close);
  await shows(linked.page, "Linked v1.");
  await writeFile(join(real, "target.md"), "Linked v2.\n");
  await shows(linked.page, "Linked v2.");
  await writeFile(join(real, "next.md"), "Linked v3.\n");
  await rename(join(real, "next.md"), join(real, "target.md"));
  await shows(linked.page, "Linked v3.");
  assert.deepEqual((await fixtureState(linked.page)).writes, []);
  assert.deepEqual(linked.errors, []);

  // Polling stops with the editor.
  const polls = await page.evaluate(() => (window as any).__fixture.fileChecks);
  assert(polls > 0, "document was not being watched");
  await page.evaluate(() => (document.querySelector(".ProseMirror") as any).editor.destroy());
  await sleep(1300);
  const after = await page.evaluate(() => (window as any).__fixture.fileChecks);
  await sleep(1300);
  assert.equal(await page.evaluate(() => (window as any).__fixture.fileChecks), after, "destroyed editor kept polling");
  assert.deepEqual(await readdir(directory).then(names => names.filter(name => name.includes("my edits"))), []);
  console.log("External text reload E2E passed: overwrite, rename, truncate, delete/recreate, same-size and mtime-only writes, git checkout, symlink, caret kept, echo-free, conflict choices.");
} finally {
  for (const close of fixtures) await close();
  await rm(directory, { recursive: true, force: true });
}
