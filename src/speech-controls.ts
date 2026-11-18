import type { Reader, ReaderView } from "./speech";

const icons = {
  play: '<svg viewBox="0 0 20 20"><path d="M6 4v12l10-6Z"/></svg>',
  pause: '<svg viewBox="0 0 20 20"><rect x="5" y="4" width="3.5" height="12" rx="1"/><rect x="11.5" y="4" width="3.5" height="12" rx="1"/></svg>',
  stop: '<svg viewBox="0 0 20 20"><rect x="5" y="5" width="10" height="10" rx="1.5"/></svg>',
};

export function mountSpeechControls(reader: Reader) {
  const root = document.createElement("div");
  root.className = "speech-controls";
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", "Read aloud");
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
  const stop = button("Stop reading", icons.stop, reader.stop);
  const rate = document.createElement("span");
  rate.className = "speech-rate";
  const message = document.createElement("span");
  message.className = "speech-message";
  message.setAttribute("role", "status");
  root.append(toggle, slower, rate, faster, stop, message);
  // Clicking a control must not move the caret out of the document.
  root.addEventListener("mousedown", event => event.preventDefault());
  document.body.append(root);

  function render({ state, rate: speed, message: text }: ReaderView) {
    const active = state !== "idle";
    root.hidden = !active && !text;
    for (const element of [toggle, slower, rate, faster, stop]) element.hidden = !active;
    const paused = state === "paused";
    toggle.innerHTML = paused ? icons.play : icons.pause;
    toggle.setAttribute("aria-label", paused ? "Resume" : "Pause");
    toggle.title = toggle.getAttribute("aria-label")!;
    rate.textContent = `${speed.toFixed(1)}×`;
    message.textContent = text;
    message.hidden = !text;
    root.dataset.state = state;
  }
  render(reader.view());
  const unsubscribe = reader.subscribe(render);

  return { destroy: () => { unsubscribe(); root.remove(); } };
}
