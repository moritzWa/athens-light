import assert from "node:assert/strict";
import { mkdtemp, writeFile, rename, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserFixture } from "./browser-fixture";

const directory = await mkdtemp(join(tmpdir(), "athens-image-reload-"));
const svg = (width: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="100"><rect width="100%" height="100%" fill="red"/></svg>`;
// Real PNGs of different dimensions, not an SVG masquerading as a raster.
const png = (width: number) => {
  const { deflateSync } = require("node:zlib");
  const crc = (data: Buffer) => {
    let value = 0xffffffff;
    for (const byte of data) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(40, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc((1 + width * 4) * 40))), chunk("IEND", Buffer.alloc(0))]);
};
const source = "Before.\n\n![Raster](picture.png)\n\n![Diagram](diagram.svg)\n\n![Duplicate](diagram.svg)\n\nAfter.";
let close: (() => Promise<void>) | undefined;
try {
  await writeFile(join(directory, "picture.png"), png(20));
  await writeFile(join(directory, "diagram.svg"), svg(100));
  const fixture = await browserFixture(source, directory);
  close = fixture.close;
  const { page, errors } = fixture;
  const widths = async (expected: number[]) => {
    await page.waitForFunction(expected => {
      const images = [...document.querySelectorAll<HTMLImageElement>(".document-image img")];
      return images.length === expected.length && images.every((image, i) => image.complete && image.naturalWidth === expected[i]);
    }, expected);
  };
  await widths([20, 100, 100]);
  await page.locator(".document-image").first().click();
  const before = await page.evaluate(() => {
    const editor = (document.querySelector(".ProseMirror") as any).editor;
    return { json: editor.getJSON(), selection: editor.state.selection.toJSON(), undo: editor.can().undo() };
  });
  // Overwrite and atomic replacement while the document stays open and focused.
  await writeFile(join(directory, "picture.png"), png(30));
  await writeFile(join(directory, "new.svg"), svg(200));
  await rename(join(directory, "new.svg"), join(directory, "diagram.svg"));
  await widths([30, 200, 200]);
  await unlink(join(directory, "diagram.svg"));
  await page.waitForFunction(() => document.querySelectorAll<HTMLImageElement>(".document-image img")[1].src.includes("athensAsset=missing"));
  await writeFile(join(directory, "diagram.svg"), svg(300));
  await widths([30, 300, 300]);
  const after = await page.evaluate(() => {
    const editor = (document.querySelector(".ProseMirror") as any).editor;
    return { json: editor.getJSON(), selection: editor.state.selection.toJSON(), undo: editor.can().undo() };
  });
  assert.deepEqual(after, before, "asset refresh changed editor state or history");
  assert.deepEqual(await page.evaluate(() => (window as any).__fixture.writes), []);
  assert.equal(await page.evaluate(() => (window as any).__fixture.disk), source);
  const checks = await page.evaluate(() => (window as any).__fixture.imageChecks as string[][]);
  assert(checks.length > 0);
  assert(checks.every(paths => paths.length === 2 && new Set(paths).size === 2), "duplicate references should share one stat per poll");
  await page.evaluate(() => (document.querySelector(".ProseMirror") as any).editor.destroy());
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => (window as any).__fixture.imageChecks.length), checks.length, "destroyed editor kept polling assets");
  assert.deepEqual(errors, []);
  console.log("External asset E2E passed: raster overwrite, SVG atomic replacement, duplicate references, deletion/recreation, no Markdown writes or editor-state changes.");
} finally {
  await close?.();
  await rm(directory, { recursive: true, force: true });
}
