import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export type Highlight = { sentence?: { from: number; to: number }; word?: { from: number; to: number } };
export const speechKey = new PluginKey<Highlight>("speech");

// The spoken sentence and word are drawn as decorations, so reading never edits
// the document or moves the caret. Any document change clears them.
export const SpeechHighlight = Extension.create({
  name: "speechHighlight",
  addProseMirrorPlugins() {
    return [new Plugin<Highlight>({
      key: speechKey,
      state: {
        init: () => ({}),
        apply: (tr, previous) => tr.getMeta(speechKey) ?? (tr.docChanged ? {} : previous),
      },
      props: {
        decorations(state) {
          const highlight = speechKey.getState(state);
          const size = state.doc.content.size;
          const decorations: Decoration[] = [];
          for (const [range, name] of [[highlight?.sentence, "speech-sentence"], [highlight?.word, "speech-word"]] as const)
            if (range && range.from < range.to && range.to <= size) decorations.push(Decoration.inline(range.from, range.to, { class: name }));
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});
