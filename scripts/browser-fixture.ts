import { chromium, webkit, type Page } from "playwright";

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

export async function browserFixture(source: string) {
  const bundle = await Bun.build({ entrypoints: [new URL("../src/main.ts", import.meta.url).pathname], target: "browser", format: "iife" });
  if (!bundle.success) throw new Error("Frontend bundle failed");
  const js = bundle.outputs.find(output => output.path.endsWith(".js"))!;
  const css = bundle.outputs.find(output => output.path.endsWith(".css"))!;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/app.js") return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      if (path === "/app.css") return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
      if (path === "/fixture-image") return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="240" height="100" fill="#e8e8ed"/><text x="20" y="56" font-size="18">Image fixture</text></svg>', { headers: { "content-type": "image/svg+xml" } });
      return new Response("<!doctype html><html><head><meta charset='utf-8'><link rel='stylesheet' href='/app.css'></head><body><div id='editor'></div><script src='/app.js'></script></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await (process.env.BROWSER === "webkit" ? webkit : chromium).launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 820, height: 920 }, colorScheme: "light" });
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    await page.addInitScript(({ source }) => {
      const state = { disk: source, writes: [] as string[], opens: [] as string[], copies: [] as string[] };
      (window as any).__fixture = state;
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { state.copies.push(text); } } });
      (window as any).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "fixture" } }, transformCallback: () => 1,
        convertFileSrc: (path: string) => `/fixture-image?path=${encodeURIComponent(path)}`,
        invoke: async (command: string, args: any) => {
          if (command === "initial_path") return "/comment-fixture.md";
          if (command === "read_file") return state.disk;
          if (command === "write_file") { state.disk = args.content; state.writes.push(args.content); }
          if (command === "open_url") state.opens.push(args.url);
          if (command === "pick_image") return "assets/my photo.png";
          return 1;
        },
      };
    }, { source });
    await page.goto(server.url.href);
    await page.locator(".ProseMirror").waitFor();
    return { page, errors, close: async () => { await browser?.close(); server.stop(true); } };
  } catch (error) { await browser?.close(); server.stop(true); throw error; }
}
