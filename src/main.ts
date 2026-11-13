import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logo from "./athens-logo.svg";
import "./style.css";

const SAVE_DELAY_MS = 400;

// Tiptap writes empty paragraphs as `&nbsp;`; plain blank lines are what we want in the file.
const normalize = (s: string) =>
  s
    .replace(/^&nbsp;$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "") + "\n";

function renderLauncher() {
  document.body.classList.add("launcher");
  document.getElementById("editor")!.innerHTML = `
    <img class="logo" src="${logo}" alt="" />
    <button id="new">New Markdown File…</button>
    <button id="open">Open File…</button>
  `;
  document.getElementById("new")!.onclick = () => invoke("new_file");
  document.getElementById("open")!.onclick = () => invoke("open_file");
}

const baseName = (p: string) => p.split("/").pop()!;

async function main() {
  const initial = await invoke<string | null>("initial_path");
  if (!initial) return renderLauncher();
  let path: string = initial;

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

  const header = document.createElement("div");
  header.id = "titlebar";
  header.setAttribute("data-tauri-drag-region", "");
  const title = document.createElement("span");
  title.id = "title";
  title.textContent = baseName(path);
  header.append(title);
  document.body.prepend(header);

  title.addEventListener("click", () => {
    const input = document.createElement("input");
    input.id = "title-input";
    input.value = baseName(path);
    input.spellcheck = false;
    title.replaceWith(input);
    input.focus();
    input.setSelectionRange(0, input.value.replace(/\.[^.]*$/, "").length);

    let done = false;
    const finish = async (commit: boolean) => {
      if (done) return;
      done = true;
      let failed = false;
      if (commit && input.value.trim() !== baseName(path)) {
        try {
          await save();
          path = await invoke<string>("rename_file", { path, newName: input.value });
        } catch {
          failed = true;
        }
      }
      title.textContent = baseName(path);
      input.replaceWith(title);
      if (failed) {
        title.classList.add("error");
        setTimeout(() => title.classList.remove("error"), 1200);
      }
      editor.commands.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  });

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
