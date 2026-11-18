import { chromium, webkit, type Page } from "playwright";
import { stat } from "node:fs/promises";

export async function openContextToolbar(page: Page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (await page.getByRole("toolbar", { name: "Formatting and insert" }).isVisible()) return;
  await page.evaluate(() => {
    const editor = (document.querySelector(".ProseMirror") as any).editor;
    const node = editor.view.domAtPos(editor.state.selection.to).node;
    (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement).scrollIntoView({ block: "center" });
  });
  const point = await page.evaluate(() => {
    const editor = (document.querySelector(".ProseMirror") as any).editor;
    const rect = editor.view.coordsAtPos(editor.state.selection.to);
    return { x: rect.left + 2, y: (rect.top + rect.bottom) / 2 };
  });
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.getByRole("toolbar", { name: "Formatting and insert" }).waitFor();
}

export async function browserFixture(source: string, assetDirectory?: string) {
  const bundle = await Bun.build({ entrypoints: [new URL("../src/main.ts", import.meta.url).pathname], target: "browser", format: "iife" });
  if (!bundle.success) throw new Error("Frontend bundle failed");
  const js = bundle.outputs.find(output => output.path.endsWith(".js"))!;
  const css = bundle.outputs.find(output => output.path.endsWith(".css"))!;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (assetDirectory && path === "/image-versions") {
        const paths = JSON.parse(url.searchParams.get("paths")!);
        return Response.json(await Promise.all(paths.map(async (path: string) => {
          assertAssetPath(path);
          try { const info = await stat(path, { bigint: true }); return `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`; }
          catch { return null; }
        })));
      }
      if (assetDirectory && path === "/fixture-image") {
        const file = url.searchParams.get("path")!;
        assertAssetPath(file);
        const asset = Bun.file(file);
        if (!await asset.exists()) return new Response("Image missing", { status: 404 });
        return new Response(asset, { headers: { "cache-control": "public, max-age=3600" } });
      }
      if (path === "/app.js") return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      if (path === "/app.css") return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
      if (path === "/fixture-image") return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="240" height="100" fill="#e8e8ed"/><text x="20" y="56" font-size="18">Image fixture</text></svg>', { headers: { "content-type": "image/svg+xml" } });
      return new Response("<!doctype html><html><head><meta charset='utf-8'><link rel='stylesheet' href='/app.css'></head><body><div id='editor'></div><script src='/app.js'></script></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  function assertAssetPath(path: string) {
    if (!path.startsWith(`${assetDirectory}/`) || path.includes("/../")) throw new Error("Unexpected fixture asset path");
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await (process.env.BROWSER === "webkit" ? webkit : chromium).launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 820, height: 920 }, colorScheme: "light" });
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    await page.addInitScript(({ source, assetDirectory }) => {
      const state = { disk: source, writes: [] as string[], opens: [] as string[], copies: [] as string[], imageCopies: [] as string[], imageChecks: [] as string[][], failImageCopy: false, speech: [] as { text: string; language: string }[], speechError: "" };
      // Silent audio with one mark per word, so reading runs without making any sound.
      const silentSpeech = (text: string) => {
        const marks: { start: number; end: number; start_time: number }[] = [];
        let codePoint = 0, word = 0, from = -1;
        for (const char of [...text, " "]) {
          if (/\s/.test(char)) { if (from >= 0) marks.push({ start: from, end: codePoint, start_time: word++ * 120 }); from = -1; }
          else if (from < 0) from = codePoint;
          codePoint++;
        }
        const rate = 8000, samples = Math.max(1, Math.round(rate * 0.12 * word));
        const bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer);
        const tag = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
        tag(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); tag(8, "WAVEfmt "); view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, samples * 2, true);
        let binary = "";
        bytes.forEach(byte => { binary += String.fromCharCode(byte); });
        return { audio: btoa(binary), marks };
      };
      (window as any).__fixture = state;
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { state.copies.push(text); } } });
      (window as any).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "fixture" } }, transformCallback: () => 1,
        convertFileSrc: (path: string) => `/fixture-image?path=${encodeURIComponent(path)}`,
        invoke: async (command: string, args: any) => {
          if (command === "initial_path") return assetDirectory ? `${assetDirectory}/note.md` : "/comment-fixture.md";
          if (command === "image_versions") {
            state.imageChecks.push(args.paths);
            return assetDirectory
              ? fetch(`/image-versions?paths=${encodeURIComponent(JSON.stringify(args.paths))}`).then(response => response.json())
              : args.paths.map(() => "fixture-version");
          }
          if (command === "read_file") return state.disk;
          if (command === "write_file") { state.disk = args.content; state.writes.push(args.content); }
          if (command === "open_url") state.opens.push(args.url);
          if (command === "speech_synthesize") {
            state.speech.push({ text: args.text, language: args.language });
            if (state.speechError) throw state.speechError;
            return silentSpeech(args.text);
          }
           if (command === "pick_image") return "assets/my photo.png";
           if (command === "copy_image_to_clipboard") {
             if (state.failImageCopy) throw new Error("Image unavailable");
             state.imageCopies.push(args.source);
           }
          return 1;
        },
      };
    }, { source, assetDirectory });
    await page.goto(server.url.href);
    await page.locator(".ProseMirror").waitFor();
    return { page, errors, close: async () => { await browser?.close(); server.stop(true); } };
  } catch (error) { await browser?.close(); server.stop(true); throw error; }
}
