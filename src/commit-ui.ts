import { summarizeChanges } from "./commit-message";

export type CommitInfo = { head: string | null; diff: string; recent: string[] };

export type CommitBackend = {
  status: () => Promise<unknown>;
  info: () => Promise<CommitInfo>;
  suggest: (diff: string, recent: string[]) => Promise<string | null>;
  commit: (message: string) => Promise<void>;
};

type Options = {
  backend: CommitBackend;
  // Writes pending edits to disk and returns exactly what is on disk.
  flush: () => Promise<string>;
  fileName: () => string;
  // Called when the panel closes by keyboard, Cancel or a finished commit.
  restoreFocus: () => void;
};

const errorText = (error: unknown) => (typeof error === "string" ? error : error instanceof Error ? error.message : "Commit failed");

// A Commit button at the top right while the open file is in a git repository and
// differs from the last commit. It commits that file alone.
export function mountCommit(header: HTMLElement, { backend, flush, fileName, restoreFocus }: Options) {
  const button = document.createElement("button");
  button.id = "commit-button";
  button.type = "button";
  button.textContent = "Commit";
  button.hidden = true;
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  header.append(button);

  const panel = document.createElement("form");
  panel.id = "commit-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Commit changes");
  const input = document.createElement("textarea");
  input.rows = 2;
  input.spellcheck = false;
  input.setAttribute("aria-label", "Commit message");
  const note = document.createElement("div");
  note.className = "commit-note";
  note.setAttribute("role", "status");
  const failure = document.createElement("div");
  failure.className = "commit-error";
  failure.setAttribute("role", "alert");
  const actions = document.createElement("div");
  actions.className = "commit-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Commit";
  actions.append(note, cancel, submit);
  panel.append(input, failure, actions);
  document.body.append(panel);

  let seq = 0;
  let opening = 0;
  let typed = false;

  const close = () => {
    opening++;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };

  async function refresh() {
    const mine = ++seq;
    let visible = false;
    try {
      const status = (await backend.status()) as { repo?: boolean; dirty?: boolean } | null;
      visible = typeof status === "object" && status !== null && status.repo === true && status.dirty === true;
    } catch {}
    if (mine !== seq) return;
    button.hidden = !visible;
    header.classList.toggle("can-commit", visible);
    if (!visible) close();
  }

  async function open() {
    const mine = ++opening;
    typed = false;
    failure.textContent = "";
    note.textContent = "Writing message…";
    submit.disabled = false;
    input.value = "";
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    input.focus();
    try {
      const text = await flush();
      const info = await backend.info();
      if (mine !== opening) return;
      if (!typed) {
        input.value = summarizeChanges(info.head, text, fileName());
        input.select();
      }
      const suggestion = await backend.suggest(info.diff, info.recent).catch(() => null);
      if (mine !== opening) return;
      if (suggestion && !typed) {
        input.value = suggestion;
        input.select();
      }
    } catch (error) {
      if (mine === opening) failure.textContent = errorText(error);
    }
    if (mine === opening) note.textContent = "";
  }

  async function commit() {
    const message = input.value.trim();
    if (!message || submit.disabled) return;
    submit.disabled = true;
    failure.textContent = "";
    try {
      await flush();
      await backend.commit(message);
      close();
      restoreFocus();
      await refresh();
    } catch (error) {
      failure.textContent = errorText(error);
      submit.disabled = false;
    }
  }

  button.addEventListener("click", () => (panel.hidden ? open() : close()));
  cancel.addEventListener("click", () => {
    close();
    restoreFocus();
  });
  input.addEventListener("input", () => {
    typed = true;
  });
  panel.addEventListener("submit", event => {
    event.preventDefault();
    commit();
  });
  panel.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      restoreFocus();
    } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      commit();
    }
  });
  const onPointerDown = (event: MouseEvent) => {
    const target = event.target as Node;
    if (!panel.hidden && !panel.contains(target) && !button.contains(target)) close();
  };
  document.addEventListener("mousedown", onPointerDown);

  return {
    refresh,
    destroy() {
      document.removeEventListener("mousedown", onPointerDown);
      button.remove();
      panel.remove();
    },
  };
}
