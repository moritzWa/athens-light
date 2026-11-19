import type { Editor } from "@tiptap/core";
import { speechKey, type Highlight } from "./speech-highlight";
import { buildScript, charAt, documentRange, wordAt, wordIndexAt, type Script } from "./speech-script";
import { pieces, type Language, type SpeechPiece } from "./speech-language";
import "./speech.css";

/** One word of a Speechify response: a code point range and its start in milliseconds. */
export type Mark = { start: number; end: number; start_time: number };
export type Speech = { audio: string; marks: Mark[] };
export type Synthesize = (text: string, language: Language) => Promise<Speech>;

/** "idle" is ordinary editing. Every other state is reader mode, where a click reads from the word. */
export type ReaderState = "idle" | "ready" | "loading" | "playing" | "paused";
export type ReaderView = { state: ReaderState; rate: number; message: string };
export type Reader = {
  toggle: () => void;
  /** Stops reading and leaves reader mode. */
  exit: () => void;
  faster: () => void;
  slower: () => void;
  /** Reads from the word at a document position, or jumps there while reading. */
  startAt: (position: number) => void;
  handleKey: (event: KeyboardEvent) => boolean;
  view: () => ReaderView;
  subscribe: (listener: (view: ReaderView) => void) => () => void;
  destroy: () => void;
};

const RATE_KEY = "athens-light.speech-rate";
const DEFAULT_RATE = 1.7;
const MIN_RATE = 0.5;
const MAX_RATE = 3;
// Seconds of audio left before the next piece is requested. Speech is billed by
// the character and most readings stop early, so pieces are fetched just in time.
const LEAD = 8;
const MESSAGE_MS = 6000;

/** The start time in seconds of each UTF-16 character of `text`, from Speechify's word marks. */
export function charStarts(text: string, marks: readonly Mark[]) {
  // Marks count code points; the script is indexed by UTF-16 unit.
  const units = [0];
  for (const char of text) units.push(units[units.length - 1] + char.length);
  const starts: number[] = [];
  for (const mark of marks)
    while (starts.length < (units[mark.end] ?? text.length)) starts.push(mark.start_time / 1000);
  // Spaces after the last word have no mark; they share its start.
  while (starts.length < text.length) starts.push(starts.at(-1) ?? 0);
  return starts.slice(0, text.length);
}

/** An emoji makes Speechify drop the last word, audio and all; a space keeps every offset. */
export function sanitize(text: string) {
  return text.replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D/gu, " ");
}

type Clip = { url: string; starts: number[] };
type Session = {
  script: Script;
  pieces: SpeechPiece[];
  clips: Map<number, Promise<Clip>>;
  index: number;
  clip?: Clip;
  word: number;
  paused: boolean;
  ended: boolean;
};

function decode(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createReader(
  editor: Editor,
  options: { synthesize: Synthesize; audio?: HTMLAudioElement; storage?: Pick<Storage, "getItem" | "setItem"> },
): Reader {
  const storage = options.storage ?? localStorage;
  // One element for every piece: once the first Cmd+S has started it, the webview
  // lets it keep playing later pieces without another user gesture.
  const audio = options.audio ?? new Audio();
  audio.preservesPitch = true;
  (audio as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;

  const stored = Number(storage.getItem(RATE_KEY));
  let rate = clampRate(stored || DEFAULT_RATE);
  audio.defaultPlaybackRate = rate;
  audio.playbackRate = rate;

  let session: Session | undefined;
  // Reader mode outlasts a reading: it stays on after the last sentence and while paused,
  // so a click can start another reading, until the user exits it.
  let active = false;
  let message = "";
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<(view: ReaderView) => void>();
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("athens-light-speech");
  const instance = Math.random().toString(36).slice(2);

  function clampRate(value: number) {
    return Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round(value * 10) / 10));
  }

  function state(): ReaderState {
    if (!session) return active ? "ready" : "idle";
    if (session.paused) return "paused";
    return session.clip && !audio.paused ? "playing" : "loading";
  }
  const view = (): ReaderView => ({ state: state(), rate, message });
  const emit = () => listeners.forEach(listener => listener(view()));

  function setActive(on: boolean) {
    active = on;
    document.body.classList.toggle("reader-mode", on);
    if (!on) {
      hoverScript = undefined;
      showHover(undefined);
    }
    emit();
  }

  // The sentence under the pointer is previewed in reader mode, since a click reads from its start.
  let hoverScript: Script | undefined;
  let hovered: { from: number; to: number } | undefined;
  function showHover(range: { from: number; to: number } | undefined) {
    if (hovered?.from === range?.from && hovered?.to === range?.to) return;
    hovered = range;
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(speechKey, { hover: range }).setMeta("addToHistory", false));
  }
  function hover(position: number | undefined) {
    if (position === undefined) return showHover(undefined);
    hoverScript ??= buildScript(editor.state.doc);
    const script = hoverScript;
    const sentence = script.sentences.find(candidate => {
      const range = documentRange(script, candidate);
      return position >= range.from && position <= range.to;
    });
    const range = sentence && documentRange(script, sentence);
    // The sentence being spoken already has its own mark.
    const speaking = speechKey.getState(editor.state)?.sentence;
    showHover(range && !(speaking && speaking.from === range.from && speaking.to === range.to) ? range : undefined);
  }

  function notify(text: string) {
    message = text;
    clearTimeout(messageTimer);
    if (text) messageTimer = setTimeout(() => { message = ""; emit(); }, MESSAGE_MS);
    emit();
  }

  function paint(highlight: Highlight) {
    if (editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(speechKey, highlight).setMeta("addToHistory", false));
  }

  function reveal(position: number) {
    try {
      const rect = editor.view.coordsAtPos(position);
      if (rect.top < 80 || rect.bottom > window.innerHeight - 90)
        window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight * 0.3, behavior: "smooth" });
    } catch {
      // The position can leave the viewport's layout while the document changes.
    }
  }

  function clipFor(current: Session, index: number) {
    let clip = current.clips.get(index);
    if (!clip) {
      const range = current.pieces[index];
      const text = current.script.text.slice(range.start, range.end);
      clip = options.synthesize(sanitize(text), range.language).then(speech => {
        if (current.ended) throw new Error("Stopped");
        const url = URL.createObjectURL(new Blob([decode(speech.audio)], { type: "audio/mpeg" }));
        return { url, starts: charStarts(text, speech.marks) };
      });
      current.clips.set(index, clip);
    }
    return clip;
  }

  function prefetch(current: Session, index: number) {
    if (index < current.pieces.length && !current.clips.has(index)) void clipFor(current, index).catch(() => {});
  }

  function ready() {
    return new Promise<void>((resolve, reject) => {
      const done = () => { audio.removeEventListener("loadedmetadata", onReady); audio.removeEventListener("error", onError); };
      const onReady = () => { done(); resolve(); };
      const onError = () => { done(); reject(new Error("The audio could not be played")); };
      audio.addEventListener("loadedmetadata", onReady);
      audio.addEventListener("error", onError);
    });
  }

  async function playPiece(current: Session, index: number, char: number) {
    current.index = index;
    current.clip = undefined;
    emit();
    try {
      const clip = await clipFor(current, index);
      if (session !== current) return;
      const loaded = ready();
      audio.src = clip.url;
      await loaded;
      if (session !== current) return;
      current.clip = clip;
      const from = current.pieces[index].start;
      if (char > from) audio.currentTime = clip.starts[char - from] ?? 0;
      if (current.paused) return emit();
      await audio.play();
      if (session !== current) return;
      update();
      emit();
    } catch (error) {
      // Pausing while play() is starting rejects it; the pause is the user's intent.
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (session === current) fail(error);
    }
  }

  function update() {
    const current = session;
    // A paused element's clock is not reliable in every webview, so the highlight holds.
    if (!current?.clip || current.paused) return;
    const range = current.pieces[current.index];
    const found = wordAt(current.script, range.start, current.clip.starts, audio.currentTime);
    if (found >= 0 && found !== current.word) {
      current.word = found;
      const word = current.script.words[found];
      const sentence = current.script.sentences.find(candidate => candidate.end > word.start)!;
      const target = documentRange(current.script, word);
      paint({ sentence: documentRange(current.script, sentence), word: target });
      reveal(target.from);
    }
    const remaining = (audio.duration - audio.currentTime) / audio.playbackRate;
    if (!Number.isFinite(remaining) || remaining <= LEAD) prefetch(current, current.index + 1);
  }

  function onEnded() {
    const current = session;
    if (!current?.clip) return;
    const next = current.index + 1;
    if (next < current.pieces.length) void playPiece(current, next, current.pieces[next].start);
    else endSession();
  }
  audio.addEventListener("ended", onEnded);

  function fail(error: unknown) {
    // Tauri rejects commands with the plain error string.
    const text = error instanceof Error ? error.message : String(error);
    exit();
    notify(text);
  }

  function exit() {
    endSession();
    if (active) setActive(false);
  }

  /** Ends the current reading and clears its highlight; reader mode stays on. */
  function endSession() {
    const current = session;
    if (!current) return;
    session = undefined;
    current.ended = true;
    clearInterval(timer);
    timer = undefined;
    current.clips.forEach(clip => clip.then(value => URL.revokeObjectURL(value.url), () => {}));
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    paint({ sentence: undefined, word: undefined });
    emit();
  }

  function begin(from: number, to: number, startChar = 0) {
    const script = buildScript(editor.state.doc, from, to);
    if (!script.words.length) return false;
    endSession();
    if (!active) setActive(true);
    channel?.postMessage({ from: instance });
    const ranges = pieces(script.text, script.blocks);
    const current: Session = { script, pieces: ranges, clips: new Map(), index: 0, word: -1, paused: false, ended: false };
    session = current;
    timer = setInterval(update, 40);
    message = "";
    const index = Math.max(0, ranges.findIndex(range => range.end > startChar));
    void playPiece(current, index, startChar);
    return true;
  }

  function toggle() {
    const current = session;
    if (!current) {
      const { from, to, empty } = editor.state.selection;
      const end = editor.state.doc.content.size;
      if (begin(from, empty ? end : to)) return;
      // A caret past the last word has nothing left to read; read the whole document.
      if (empty && begin(0, end)) return;
      return notify("Nothing to read");
    }
    if (current.paused) {
      current.paused = false;
      if (current.clip) void audio.play().then(emit, fail);
      emit();
    } else {
      current.paused = true;
      audio.pause();
      emit();
    }
  }

  function startAt(position: number) {
    const current = session;
    if (current) {
      const { script } = current;
      if (position >= script.pos[0] && position <= script.pos[script.pos.length - 1] + 1) {
        const char = sentenceStart(script, script.words[wordIndexAt(script, charAt(script, position))].start);
        current.paused = false;
        const index = Math.max(0, current.pieces.findIndex(range => range.end > char));
        if (index === current.index && current.clip) {
          audio.currentTime = current.clip.starts[char - current.pieces[index].start] ?? 0;
          if (audio.paused) void audio.play().then(emit, fail);
          current.word = -1;
          update();
        } else void playPiece(current, index, char);
        return emit();
      }
    }
    // Start from the clicked word, not the start of its block, so the text before
    // it is not synthesized.
    const $position = editor.state.doc.resolve(position);
    const end = editor.state.doc.content.size;
    const block = buildScript(editor.state.doc, $position.depth ? $position.start() : position, end);
    if (!block.words.length) return notify("Nothing to read");
    const start = sentenceStart(block, block.words[wordIndexAt(block, charAt(block, position))].start);
    begin(block.pos[start], end);
  }

  /** Reading starts at the beginning of the clicked sentence, not mid-sentence. */
  function sentenceStart(script: Script, char: number) {
    return script.sentences.find(sentence => sentence.end > char)?.start ?? char;
  }

  function setRate(value: number) {
    rate = clampRate(value);
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    storage.setItem(RATE_KEY, String(rate));
    emit();
  }

  // In reader mode a click reads from that word. Option+click does the same outside it.
  // Either way the click must not also move the caret, select text or open a link.
  const claims = (event: MouseEvent) => (active || event.altKey) && !event.metaKey && !event.ctrlKey;
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || !claims(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const at = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
    // The sentence is about to get its own mark; a stale preview would reappear once reading moves on.
    showHover(undefined);
    if (at) startAt(at.pos);
  };
  const swallowClick = (event: MouseEvent) => {
    if (!claims(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onMouseMove = (event: MouseEvent) => {
    if (!active) return;
    hover(editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
  };
  const onMouseLeave = () => hover(undefined);
  const dom = editor.view.dom;
  dom.addEventListener("mousemove", onMouseMove);
  dom.addEventListener("mouseleave", onMouseLeave);
  dom.addEventListener("mousedown", onMouseDown, true);
  dom.addEventListener("click", swallowClick, true);

  // Another window starting to read stops this one, so only one voice speaks.
  channel?.addEventListener("message", event => {
    if (event.data?.from !== instance) exit();
  });
  // Positions in the script are only valid for the document it was built from;
  // reloads from disk change the document without an "update" event.
  const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
    if (transaction.docChanged) exit();
  };
  editor.on("transaction", onTransaction);

  return {
    toggle,
    exit,
    faster: () => setRate(rate + 0.1),
    slower: () => setRate(rate - 0.1),
    startAt,
    handleKey(event) {
      if (!active || event.metaKey || event.ctrlKey) return false;
      if (event.key === "Escape" && !event.altKey && !event.shiftKey) return exit(), true;
      if (event.altKey && event.code === "Equal") return setRate(rate + 0.1), true;
      if (event.altKey && event.code === "Minus") return setRate(rate - 0.1), true;
      return false;
    },
    view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      exit();
      clearTimeout(messageTimer);
      audio.removeEventListener("ended", onEnded);
      dom.removeEventListener("mousemove", onMouseMove);
      dom.removeEventListener("mouseleave", onMouseLeave);
      dom.removeEventListener("mousedown", onMouseDown, true);
      dom.removeEventListener("click", swallowClick, true);
      editor.off("transaction", onTransaction);
      channel?.close();
      listeners.clear();
    },
  };
}
