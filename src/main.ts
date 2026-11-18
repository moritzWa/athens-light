import { Editor } from "@tiptap/core";
import { extensions } from "./extensions";
import { splitFrontMatter } from "./frontmatter";
import { loadMarkdown } from "./document";
import { normalizeMarkdown as normalize } from "./comments";
import { mountComments } from "./comment-ui";
import { mountLinks } from "./link-ui";
import { mountToolbar } from "./toolbar";
import { mountTableControls } from "./table-ui";
import { mountImageReload, setImageDocumentPath } from "./images";
import { createPathCopiedToast } from "./toast";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logo from "./athens-logo.svg";
import "./style.css";

const SAVE_DELAY_MS = 400;

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
  document.title = baseName(path);
  const showPathCopied = createPathCopiedToast(document);
  await getCurrentWindow().listen("path-copied", showPathCopied);

  let lastDisk = await invoke<string>("read_file", { path });
  let { front, body } = splitFrontMatter(lastDisk);
  let timer: number | undefined;

  const editor = new Editor({
    element: document.getElementById("editor")!,
    extensions,
    autofocus: "start",
    onUpdate: () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(save, SAVE_DELAY_MS);
    },
  });
  setImageDocumentPath(editor, path);
  const stopImageReload = mountImageReload(editor);
  editor.on("destroy", stopImageReload);

  // What the editor produces for the untouched file. Saves only happen when
  // the content differs from this, so merely opening a file never rewrites it.
  const serialize = () => front + normalize(editor.getMarkdown());
  let synced: string;

  async function save() {
    window.clearTimeout(timer);
    timer = undefined;
    if (!editor.isEditable) return;
    const md = serialize();
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

  function load() {
    const unsupported = loadMarkdown(editor, body);
    header.querySelector("#badge")?.remove();
    if (unsupported) {
      const badge = document.createElement("span");
      badge.id = "badge";
      badge.textContent = `Read-only: this file has ${unsupported}, which Athens Light can't save`;
      header.append(badge);
    }
  }
  load();
  synced = serialize();
  const comments = mountComments(editor);
  editor.on("destroy", () => comments.destroy());
  const links = mountLinks(editor, url => invoke("open_url", { url }));
  editor.on("destroy", () => links.destroy());
  const tableControls = mountTableControls(editor);
  editor.on("destroy", () => tableControls.destroy());
  const toolbar = mountToolbar(editor, { comment: comments.add, canComment: comments.canAdd, pickImage: () => invoke<string | null>("pick_image", { path }) });
  editor.on("destroy", () => toolbar.destroy());

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
          setImageDocumentPath(editor, path);
        } catch {
          failed = true;
        }
      }
      title.textContent = baseName(path);
      document.title = baseName(path);
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
    ({ front, body } = splitFrontMatter(disk));
    load();
    synced = serialize();
  });

  window.addEventListener("keydown", (e) => {
    if (e.metaKey && e.key === "s") {
      e.preventDefault();
      save();
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
