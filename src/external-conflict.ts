export type ConflictChoice = "mine" | "theirs" | "both";

// Shown when the file changed on disk while the editor holds unsaved edits.
// Autosave stays paused until one of the three choices is made.
export function showConflict(document: Document, choose: (choice: ConflictChoice) => void): () => void {
  const bar = document.createElement("div");
  bar.id = "external-conflict";
  bar.setAttribute("role", "alert");
  const message = document.createElement("span");
  message.textContent = "This file changed outside Athens Light, and you have unsaved edits.";
  bar.append(message);
  const choices: [ConflictChoice, string, string][] = [
    ["mine", "Keep mine", "Overwrite the file with what is in this window"],
    ["theirs", "Take theirs", "Discard my unsaved edits and show the file as it is on disk"],
    ["both", "Keep both", "Show the file on disk and save my version as a separate file next to it"],
  ];
  for (const [choice, label, hint] of choices) {
    const button = document.createElement("button");
    button.textContent = label;
    button.title = hint;
    button.addEventListener("click", () => choose(choice));
    bar.append(button);
  }
  document.body.append(bar);
  return () => bar.remove();
}
