import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

type Range = { from: number; to: number };
/** The sentence and word being spoken, and the sentence a click would start reading from. */
export type Highlight = { sentence?: Range; word?: Range; hover?: Range };
export const speechKey = new PluginKey<Highlight>("speech");

const classes = { hover: "speech-hover", sentence: "speech-sentence", word: "speech-word" } as const;

// The marks are drawn as decorations, so reading never edits the document or moves
// the caret. A transaction sets only the keys it names; any document change clears all.
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
      props: {
        decorations(state) {
          const highlight = speechKey.getState(state);
          const size = state.doc.content.size;
          const decorations: Decoration[] = [];
          // Later decorations nest inside earlier ones: the word sits in the sentence.
          for (const name of ["hover", "sentence", "word"] as const) {
            const range = highlight?.[name];
            if (range && range.from < range.to && range.to <= size) decorations.push(Decoration.inline(range.from, range.to, { class: classes[name] }));
          }
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});
