import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { pathOf, type Row } from "./speech-mark-path";

type Range = { from: number; to: number };
/** The sentence and word being spoken, and the sentence a click would start reading from. */
export type Highlight = { sentence?: Range; word?: Range; hover?: Range };
export const speechKey = new PluginKey<Highlight>("speech");

const classes = { hover: "speech-hover", sentence: "speech-sentence", word: "speech-word" } as const;
const NAMES = ["hover", "sentence", "word"] as const;
const SVG = "http://www.w3.org/2000/svg";
/** Pixels of mark past the text, left and right, and the corner radius. The word's pad covers the spaces around it, and the sentence reaches further so the word never meets its edge. */
const SHAPE = {
  hover: { pad: 8, radius: 6, inset: 0 },
  sentence: { pad: 8, radius: 6, inset: 0 },
  word: { pad: 4, radius: 5, inset: 1 },
} as const;

/** The boxes of the text between two positions, one per line, as the browser laid them out. */
function rowsOf(view: EditorView, range: Range, host: DOMRect, name: keyof typeof SHAPE): Row[] {
  const start = view.domAtPos(range.from);
  const end = view.domAtPos(range.to);
  const span = document.createRange();
  span.setStart(start.node, start.offset);
  span.setEnd(end.node, end.offset);
  const root = span.commonAncestorContainer;
  const texts: Text[] = [];
  if (root.nodeType === Node.TEXT_NODE) texts.push(root as Text);
  else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (span.intersectsNode(node)) texts.push(node as Text);
  }
  const boxes: DOMRect[] = [];
  let lineHeight = 0;
  const piece = document.createRange();
  for (const text of texts) {
    if (text.parentElement?.closest('[contenteditable="false"]')) continue;
    let at: number;
    try { at = view.posAtDOM(text, 0); } catch { continue; }
    const from = Math.max(range.from, at);
    const to = Math.min(range.to, at + text.length);
    if (from >= to) continue;
    piece.setStart(text, from - at);
    piece.setEnd(text, to - at);
    for (const box of piece.getClientRects()) if (box.width) boxes.push(box);
    lineHeight ||= parseFloat(getComputedStyle(text.parentElement!).lineHeight);
  }
  const rows: Row[] = [];
  for (const box of boxes) {
    const row = rows[rows.length - 1];
    // On the line of the box before it when it starts above that one's middle.
    if (row && box.top < (row.t + row.b) / 2) {
      row.l = Math.min(row.l, box.left);
      row.r = Math.max(row.r, box.right);
      row.t = Math.min(row.t, box.top);
      row.b = Math.max(row.b, box.bottom);
    } else rows.push({ l: box.left, r: box.right, t: box.top, b: box.bottom });
  }
  const { pad, inset } = SHAPE[name];
  return rows.map(row => {
    // Each line is grown to the full line height, so stacked lines meet and a lone line sits evenly in its band.
    const grow = Number.isFinite(lineHeight) ? Math.max(0, (lineHeight - (row.b - row.t)) / 2) : 0;
    return { l: row.l - host.left - pad, r: row.r - host.left + pad, t: row.t - host.top - grow + inset, b: row.b - host.top + grow - inset };
  });
}

// The marks are decorations, so reading never edits the document or moves the caret. A
// transaction sets only the keys it names; any document change clears all. The decorations
// only tag the text; the colour is drawn as one shape per mark behind the page text (see speech.css),
// because a background on the text is a box per line with notches where the lines meet and no
// room for padding that does not move the text.
export const SpeechHighlight = Extension.create({
  name: "speechHighlight",
  addProseMirrorPlugins() {
    return [new Plugin<Highlight>({
      key: speechKey,
      state: {
        init: () => ({}),
        apply(tr, previous) {
          const change: Highlight | undefined = tr.getMeta(speechKey);
          if (change) return { ...previous, ...change };
          return tr.docChanged ? {} : previous;
        },
      },
      view(view) {
        const host = view.dom.parentElement;
        if (!host) return {};
        const svg = document.createElementNS(SVG, "svg");
        svg.setAttribute("class", "speech-marks");
        svg.setAttribute("aria-hidden", "true");
        const paths = Object.fromEntries(NAMES.map(name => {
          const path = document.createElementNS(SVG, "path");
          path.setAttribute("class", name);
          svg.appendChild(path);
          return [name, path];
        })) as Record<typeof NAMES[number], SVGPathElement>;
        host.appendChild(svg);
        const draw = () => {
          const highlight = speechKey.getState(view.state);
          const size = view.state.doc.content.size;
          const box = host.getBoundingClientRect();
          for (const name of NAMES) {
            const range = highlight?.[name];
            let d = "";
            if (range && range.from < range.to && range.to <= size) {
              try { d = pathOf(rowsOf(view, range, box, name), SHAPE[name].radius); } catch { d = ""; }
            }
            paths[name].setAttribute("d", d);
          }
        };
        const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(draw);
        resized?.observe(view.dom);
        draw();
        return { update: draw, destroy() { resized?.disconnect(); svg.remove(); } };
      },
      props: {
        decorations(state) {
          const highlight = speechKey.getState(state);
          const size = state.doc.content.size;
          const decorations: Decoration[] = [];
          // Later decorations nest inside earlier ones: the word sits in the sentence.
          for (const name of NAMES) {
            const range = highlight?.[name];
            if (range && range.from < range.to && range.to <= size) decorations.push(Decoration.inline(range.from, range.to, { class: classes[name] }));
          }
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});
