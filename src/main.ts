import { Editor } from "@tiptap/core";
import { extensions } from "./extensions";
import { splitFrontMatter } from "./frontmatter";
import { loadMarkdown, keepPlace } from "./document";
import { showConflict, type ConflictChoice } from "./external-conflict";
import { normalizeMarkdown as normalize } from "./comments";
import { mountComments } from "./comment-ui";
import { mountLinks } from "./link-ui";
import { mountToolbar } from "./toolbar";
import { mountCommit, type CommitInfo } from "./commit-ui";
import { mountTableControls } from "./table-ui";
import { mountImageReload, setImageDocumentPath } from "./images";
import { createPathCopiedToast } from "./toast";
import { createReader, type Speech } from "./speech";
import { mountSpeechControls } from "./speech-controls";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logo from "./athens-logo.svg";
import "./style.css";

const SAVE_DELAY_MS = 400;
const WATCH_INTERVAL_MS = 1000;

type RecentFile = { path: string; name: string; dir: string };

async function renderLauncher() {
  document.body.classList.add("launcher");
  const recent = await invoke<RecentFile[]>("recent_files");
  document.getElementById("editor")!.innerHTML = `
    <img class="logo" src="${logo}" alt="" />
    <button id="new">New Markdown File…</button>
    <button id="open">Open File…</button>
    ${recent.length ? `<div class="recent-title">Recent</div><ul class="recent"></ul>` : ""}
  `;
  document.getElementById("new")!.onclick = () => invoke("new_file");
  document.getElementById("open")!.onclick = () => invoke("open_file");
  const list = document.querySelector<HTMLUListElement>("ul.recent");
  for (const file of recent) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = file.name;
    const dir = document.createElement("span");
    dir.className = "recent-dir";
    dir.textContent = file.dir;
    item.title = file.path;
    item.append(name, dir);
    item.onclick = () => invoke("open_recent", { path: file.path });
    list?.append(item);
  }
}

const baseName = (p: string) => p.split("/").pop()!;

// Where "Keep both" puts the version that was in the window, e.g. "note (my edits 2026-11-18 14.30.05).md".
function copyPath(path: string) {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  return path.replace(/(\.[^./]*)?$/, ` (my edits ${stamp})$1`);
}

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

  let commitUi: ReturnType<typeof mountCommit> | undefined;
  let saves = 0;
  let knownVersion: string | null | undefined;
  let conflict: { theirs: string; close: () => void } | undefined;
  const dirty = () => editor.isEditable && (timer !== undefined || serialize() !== synced);

  let writing = false;

  async function write() {
    const md = serialize();
    writing = true;
    try {
      await invoke("write_file", { path, content: md });
    } finally {
      writing = false;
    }
    synced = md;
    lastDisk = md;
    saves++;
    void commitUi?.refresh();
  }

  async function save() {
    window.clearTimeout(timer);
    timer = undefined;
    if (!editor.isEditable || conflict) return;
    if (serialize() === synced) return;
    // Never write over an external change we have not looked at yet.
    try { if (await checkDisk(false)) return; } catch { /* unreadable file: save as before */ }
    await write();
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
  commitUi = mountCommit(header, {
    backend: {
      status: () => invoke("git_status", { path }),
      info: () => invoke<CommitInfo>("git_commit_info", { path }),
      suggest: (diff, recent) => invoke<string | null>("git_commit_message", { diff, recent }),
      commit: message => invoke("git_commit", { path, message }),
    },
    flush: async () => {
      await save();
      if (conflict) throw new Error("The file changed outside Athens Light. Resolve that first.");
      return lastDisk;
    },
    fileName: () => baseName(path),
    restoreFocus: () => editor.view.focus(),
  });
  editor.on("destroy", () => commitUi?.destroy());
  void commitUi.refresh();
  const comments = mountComments(editor);
  editor.on("destroy", () => comments.destroy());
  const links = mountLinks(editor, url => invoke("open_url", { url }));
  editor.on("destroy", () => links.destroy());
  const tableControls = mountTableControls(editor);
  editor.on("destroy", () => tableControls.destroy());
  const toolbar = mountToolbar(editor, { comment: comments.add, canComment: comments.canAdd, pickImage: () => invoke<string | null>("pick_image", { path }) });
  editor.on("destroy", () => toolbar.destroy());
  const reader = createReader(editor, { synthesize: (text, language) => invoke<Speech>("speech_synthesize", { text, language }) });
  const speechControls = mountSpeechControls(reader);
  editor.on("destroy", () => { speechControls.destroy(); reader.destroy(); });

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
          if (conflict) throw new Error("Unresolved external change");
          path = await invoke<string>("rename_file", { path, newName: input.value });
          knownVersion = undefined;
          setImageDocumentPath(editor, path);
          void commitUi?.refresh();
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

  function accept(disk: string) {
    window.clearTimeout(timer);
    timer = undefined;
    lastDisk = disk;
    ({ front, body } = splitFrontMatter(disk));
    const restore = keepPlace(editor);
    load();
    synced = serialize();
    restore();
    void commitUi?.refresh();
  }

  // True when the file changed outside the app and was reloaded or raised a conflict.
  async function inspectDisk(force: boolean): Promise<boolean> {
    const current = path;
    const version = await invoke<string | null>("file_version", { path });
    if (!force && (version === null || version === knownVersion)) return false;
    const before = saves;
    if (writing) return false;
    const disk = await invoke<string>("read_file", { path });
    // Our own save may be what changed the file; look again on the next check.
    if (writing || saves !== before || path !== current) return false;
    knownVersion = version;
    if (disk === lastDisk) return false;
    if (conflict) {
      conflict.theirs = disk;
      lastDisk = disk;
    } else if (dirty()) {
      lastDisk = disk;
      conflict = { theirs: disk, close: showConflict(document, choice => void resolve(choice)) };
    } else {
      accept(disk);
    }
    return true;
  }

  let checks: Promise<unknown> = Promise.resolve();
  function checkDisk(force: boolean): Promise<boolean> {
    const run = checks.then(() => inspectDisk(force));
    checks = run.catch(() => {});
    return run;
  }

  async function resolve(choice: ConflictChoice) {
    const current = conflict;
    if (!current) return;
    try {
      if (choice === "mine") {
        await write();
      } else {
        if (choice === "both") await invoke("write_file", { path: copyPath(path), content: serialize() });
        accept(current.theirs);
      }
    } catch (error) {
      console.warn("Could not resolve the external change", error);
      return;
    }
    conflict = undefined;
    current.close();
  }

  // Other apps, git and agents change the open file at any time, so watch it
  // instead of waiting for focus. Stat-polling survives every way of replacing it.
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try { await checkDisk(false); } catch (error) { console.warn("Could not check the open file", error); }
    polling = false;
  };
  const watcher = window.setInterval(poll, WATCH_INTERVAL_MS);
  const refocus = () => {
    void commitUi?.refresh();
    void checkDisk(true).catch(() => {});
  };
  window.addEventListener("focus", refocus);
  editor.on("destroy", () => {
    window.clearInterval(watcher);
    window.removeEventListener("focus", refocus);
    conflict?.close();
  });

  // Saving is automatic, so Cmd+S reads aloud; it still flushes a pending save.
  window.addEventListener("keydown", (e) => {
    if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key === "s") {
      e.preventDefault();
      save();
      if (!e.repeat) reader.toggle();
    } else if (reader.handleKey(e)) {
      e.preventDefault();
    }
  });

  await getCurrentWindow().onCloseRequested(async (e) => {
    if (conflict) return e.preventDefault();
    if (timer === undefined) return;
    e.preventDefault();
    await save();
    if (!conflict) await getCurrentWindow().destroy();
  });
}

main();
