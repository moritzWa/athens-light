import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./style.css";

const SAVE_DELAY_MS = 400;

const normalize = (s: string) => s.replace(/\s+$/, "") + "\n";

async function main() {
  const path = await invoke<string | null>("initial_path");
  if (!path) return;

  let lastDisk = await invoke<string>("read_file", { path });
  let timer: number | undefined;

  const editor = new Editor({
    element: document.getElementById("editor")!,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Markdown,
      Table,
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: lastDisk,
    contentType: "markdown",
    autofocus: "start",
    onUpdate: () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(save, SAVE_DELAY_MS);
    },
  });

  // What the editor produces for the untouched file. Saves only happen when
  // the content differs from this, so merely opening a file never rewrites it.
  let synced = normalize(editor.getMarkdown());

  async function save() {
    window.clearTimeout(timer);
    timer = undefined;
    const md = normalize(editor.getMarkdown());
    if (md === synced) return;
    await invoke("write_file", { path, content: md });
    synced = md;
    lastDisk = md;
  }

  // Pick up edits made outside the app (git, agents) when the window regains focus.
  window.addEventListener("focus", async () => {
    if (timer !== undefined) return;
    const disk = await invoke<string>("read_file", { path });
    if (disk === lastDisk) return;
    lastDisk = disk;
    editor.commands.setContent(disk, { contentType: "markdown", emitUpdate: false });
    synced = normalize(editor.getMarkdown());
  });

  window.addEventListener("keydown", (e) => {
    if (e.metaKey && e.key === "s") {
      e.preventDefault();
      save();
    }
  });

  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (a && e.metaKey) {
      e.preventDefault();
      invoke("open_url", { url: a.href });
    }
  });

  await getCurrentWindow().onCloseRequested(async (e) => {
    if (timer === undefined) return;
    e.preventDefault();
    await save();
    await getCurrentWindow().destroy();
  });
}

main();
