import type { Reader, ReaderView } from "./speech";

const icons = {
  play: '<svg viewBox="0 0 20 20"><path d="M6 4v12l10-6Z"/></svg>',
  pause: '<svg viewBox="0 0 20 20"><rect x="5" y="4" width="3.5" height="12" rx="1"/><rect x="11.5" y="4" width="3.5" height="12" rx="1"/></svg>',
  exit: '<svg viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"/></svg>',
};

export function mountSpeechControls(reader: Reader) {
  const root = document.createElement("div");
  root.className = "speech-controls";
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", "Reader mode");
  root.hidden = true;

  const button = (label: string, html: string, action: () => void) => {
    const element = document.createElement("button");
    element.type = "button";
    element.setAttribute("aria-label", label);
    element.title = label;
    element.innerHTML = html;
    element.addEventListener("click", action);
    return element;
  };
  const toggle = button("Pause", icons.pause, reader.toggle);
  const slower = button("Slower", "−", reader.slower);
  const faster = button("Faster", "+", reader.faster);
  const exit = button("Exit reader mode", icons.exit, reader.exit);
  const rate = document.createElement("span");
  rate.className = "speech-rate";
  const message = document.createElement("span");
  message.className = "speech-message";
  message.setAttribute("role", "status");
  // The one thing a new user needs: in reader mode a click reads from the word.
  const hint = document.createElement("span");
  hint.className = "speech-hint";
  hint.textContent = "Click a sentence to read from it";
  root.append(toggle, slower, rate, faster, exit, hint, message);
  // Clicking a control must not move the caret out of the document.
  root.addEventListener("mousedown", event => event.preventDefault());
  document.body.append(root);

  function render({ state, rate: speed, message: text }: ReaderView) {
    const active = state !== "idle";
    root.hidden = !active && !text;
    for (const element of [toggle, slower, rate, faster, exit]) element.hidden = !active;
    const label = state === "playing" || state === "loading" ? "Pause" : state === "paused" ? "Resume" : "Read from cursor";
    toggle.innerHTML = state === "playing" || state === "loading" ? icons.pause : icons.play;
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    rate.textContent = `${speed.toFixed(1)}×`;
    message.textContent = text;
    message.hidden = !text;
    hint.hidden = !active || !!text;
    root.dataset.state = state;
  }
  render(reader.view());
  const unsubscribe = reader.subscribe(render);

  return { destroy: () => { unsubscribe(); root.remove(); } };
}
