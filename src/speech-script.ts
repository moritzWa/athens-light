import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export type Range = { start: number; end: number };

/**
 * The text sent to the voice, built from the editor's text blocks. Every spoken
 * character remembers its document position, because the highlight is drawn on
 * the document itself.
 */
export type Script = {
  text: string;
  /** Document position of each spoken character. */
  pos: Int32Array;
  /** Index of the text block each spoken character came from. */
  block: Int32Array;
  words: Range[];
  sentences: Range[];
  blocks: Range[];
};

// Code, footnote bodies and hidden comments are not read.
const SKIPPED = new Set(["codeBlock", "footnoteDefinition", "unusedFootnote", "htmlComment"]);

// Session IDs, commit hashes and UUIDs are spoken letter by letter, so they are skipped.
// A token counts as one when a run of 7+ letters and digits in it has 3+ digits and a
// letter, which leaves names like dominic_32, simba-3.2, or iPhone15Pro.
const TOKEN = /(?<![\w-])[A-Za-z0-9][\w-]*/g;
const ID_RUN = /^(?=.*[A-Za-z])(?=(?:.*\d){3})[A-Za-z0-9]{7,}$/;
// Timestamps and other bare runs of 10+ digits, with the separator in front.
const DIGITS = /[-_]?(?<![A-Za-z0-9])\d{10,}(?![A-Za-z0-9])/g;
// Line references after a file name (script.ts:28-35, file.py#L40) are dropped.
const LINES = /(?<=\.[A-Za-z][A-Za-z0-9]{0,7})(?::\d+(?:[-–:]\d+)*|#L\d+(?:-L?\d+)?)(?![\w])/g;
// File paths with two or more slashes are read as their last part. Needs a letter
// so dates like 10/09/2026 survive.
const PATH = /(?<![\w.~/-])(?:~|\.{1,2})?\/?(?:[\w.@-]+\/){2,}[\w.@-]*/g;
const URL = /https?:\/\/\S+|\bwww\.\S+|\S+@\S+\.\S+/g;
// Arrows are read as "to", so "client -> server" is not "client dash greater than server".
const ARROW = /[ \t]*(?:-{1,2}>|={1,2}>|[→⟶⇒])[ \t]*/g;
const TERMINAL = /[.!?:;]$/;

type Block = { text: string; pos: number[] };

function textBlocks(doc: ProseMirrorNode, from: number, to: number): Block[] {
  const blocks: Block[] = [];
  doc.nodesBetween(from, to, (node, at) => {
    if (SKIPPED.has(node.type.name)) return false;
    if (!node.isTextblock) return true;
    const block: Block = { text: "", pos: [] };
    const add = (char: string, pos: number) => {
      if (pos < from || pos >= to) return;
      block.text += char;
      block.pos.push(pos);
    };
    node.forEach((child, offset) => {
      const start = at + 1 + offset;
      if (child.isText) for (let index = 0; index < child.text!.length; index++) add(child.text![index], start + index);
      else if (child.type.name === "hardBreak") add(" ", start);
    });
    blocks.push(block);
    return false;
  });
  return blocks;
}

/** The spoken script for the document characters in [from, to). */
export function buildScript(doc: ProseMirrorNode, from = 0, to = doc.content.size): Script {
  const chars: string[] = [];
  const pos: number[] = [];
  const block: number[] = [];
  const pop = () => {
    chars.pop();
    pos.pop();
    block.pop();
  };

  for (const source of textBlocks(doc, from, to)) {
    const raw = source.text;
    const before = chars.length;
    const index = blockCount(block);
    const emit = (char: string, at: number) => {
      chars.push(char);
      pos.push(at);
      block.push(index);
    };
    const skip = new Uint8Array(raw.length);
    for (const match of raw.matchAll(TOKEN))
      if (match[0].split(/[_-]/).some(run => ID_RUN.test(run))) skip.fill(1, match.index, match.index + match[0].length);
    for (const pattern of [DIGITS, LINES, URL])
      for (const match of raw.matchAll(pattern)) skip.fill(1, match.index, match.index + match[0].length);
    for (const match of raw.matchAll(PATH)) {
      if (!/[A-Za-z]/.test(match[0])) continue;
      const trimmed = match[0].replace(/\/+$/, "");
      skip.fill(1, match.index, match.index + trimmed.lastIndexOf("/") + 1);
      skip.fill(1, match.index + trimmed.length, match.index + match[0].length);
    }
    const arrows = new Map<number, number>();
    for (const match of raw.matchAll(ARROW)) if (!skip[match.index]) arrows.set(match.index, match[0].length);

    for (let i = 0; i < raw.length; i++) {
      if (skip[i]) continue;
      const arrow = arrows.get(i);
      if (arrow) {
        for (const char of " to ") emit(char, source.pos[i]);
        i += arrow - 1;
        continue;
      }
      if (/\s/.test(raw[i])) {
        if (chars.length > before && chars[chars.length - 1] !== " ") emit(" ", source.pos[i]);
      } else emit(raw[i], source.pos[i]);
    }

    while (chars.length > before && chars[chars.length - 1] === " ") pop();
    if (chars.length === before) continue;
    // A heading or list item has no terminal punctuation; without one the voice
    // runs it straight into the next block.
    if (!TERMINAL.test(chars[chars.length - 1])) emit(".", pos[pos.length - 1]);
    emit(" ", pos[pos.length - 1]);
  }
  while (chars.length && chars[chars.length - 1] === " ") pop();

  const text = chars.join("");
  const words = [...text.matchAll(/\S+/g)].map(match => ({ start: match.index, end: match.index + match[0].length }));
  return {
    text,
    pos: Int32Array.from(pos),
    block: Int32Array.from(block),
    words,
    blocks: block.reduce<Range[]>((ranges, value, at) => {
      if (at === 0 || value !== block[at - 1]) ranges.push({ start: at, end: at + 1 });
      else ranges[ranges.length - 1].end = at + 1;
      return ranges;
    }, []),
    sentences: sentences(text, block, words),
  };
}

function blockCount(block: number[]) {
  return block.length ? block[block.length - 1] + 1 : 0;
}

function sentences(text: string, block: number[], words: Range[]) {
  return words.reduce<Range[]>((out, word, index) => {
    const current = out[out.length - 1];
    const previous = words[index - 1];
    const split =
      !current ||
      block[word.start] !== block[previous.start] ||
      /[.!?]["')\]]*$/.test(text.slice(previous.start, previous.end));
    if (split) out.push({ start: word.start, end: word.end });
    else current.end = word.end;
    return out;
  }, []);
}

/** The document range a range of spoken characters covers. */
export function documentRange(script: Script, range: Range) {
  return { from: script.pos[range.start], to: script.pos[range.end - 1] + 1 };
}

/** First spoken character at or after a document position. */
export function charAt(script: Script, position: number) {
  let lo = 0;
  let hi = script.pos.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (script.pos[mid] < position) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, Math.max(0, script.pos.length - 1));
}

/** Index of the word containing spoken character `char`, or the next word after it. */
export function wordIndexAt(script: Script, char: number) {
  const index = script.words.findIndex(word => word.end > char);
  return index < 0 ? script.words.length - 1 : index;
}

/**
 * Index of the word being spoken at `time`, among words that start in [from, to),
 * given the start time of each character in that range.
 */
export function wordAt(script: Script, from: number, starts: ArrayLike<number>, time: number) {
  const first = script.words.findIndex(word => word.start >= from);
  if (first < 0) return -1;
  let hi = first;
  while (hi + 1 < script.words.length && script.words[hi + 1].start < from + starts.length) hi++;
  const startOf = (word: number) => starts[script.words[word].start - from] ?? Infinity;
  if (time < startOf(first)) return -1;
  let lo = first;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (startOf(mid) <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
