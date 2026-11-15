import { Extension, Node, type JSONContent, type MarkdownRendererHelpers } from "@tiptap/core";
import { Fragment, type Node as DocumentNode } from "@tiptap/pm/model";
import { Plugin, TextSelection } from "@tiptap/pm/state";

export const footnoteKey = (label: string) => String(label ?? "").toLowerCase();
const isDefinition = (node: DocumentNode) => ["footnoteDefinition", "unusedFootnote"].includes(node.type.name);
function definition(node: DocumentNode): DocumentNode | null {
  if (node.type.name === "footnoteDefinition") return node;
  if (node.type.name !== "unusedFootnote" || !node.attrs.definition) return null;
  try { return node.type.schema.nodeFromJSON(node.attrs.definition); } catch { return null; }
}

// Clipboard snapshots deliberately omit other snapshots to avoid recursively
// embedding notes that refer to one another.
export function footnoteSnapshot(node: DocumentNode): JSONContent {
  return JSON.parse(JSON.stringify(node.toJSON(), (name, value) => name === "definition" ? undefined : value));
}

export function footnoteNumbers(doc: DocumentNode) {
  const result = new Map<string, number>();
  const notes = new Map<string, DocumentNode>();
  doc.descendants(node => {
    const note = definition(node);
    if (note) { if (!notes.has(footnoteKey(note.attrs.label))) notes.set(footnoteKey(note.attrs.label), note); return false; }
  });
  function scan(node: DocumentNode) {
    node.descendants(child => {
      if (isDefinition(child)) return false;
      if (child.type.name === "footnoteReference" && !result.has(footnoteKey(child.attrs.label))) result.set(footnoteKey(child.attrs.label), result.size + 1);
    });
  }
  scan(doc);
  // References inside a note follow all references in the main text.
  for (const label of result.keys()) { const note = notes.get(label); if (note) scan(note); }
  return result;
}

export function renderFootnote(node: JSONContent, helpers: MarkdownRendererHelpers) {
  const content = helpers.renderChildren(node.content ?? [], "\n\n");
  const [first, ...rest] = content.split("\n");
  return `[^${node.attrs?.label}]: ${first}` + (rest.length ? "\n" + rest.map(line => line ? `    ${line}` : "").join("\n") : "");
}

// Keep imported orphan definitions as invisible atoms, not editable hidden
// textblocks. They survive saving without trapping the caret in invisible text.
export const UnusedFootnote = Node.create({
  name: "unusedFootnote",
  group: "block",
  atom: true,
  selectable: false,
  addAttributes: () => ({ label: { default: "", rendered: false }, definition: { default: null, rendered: false } }),
  parseHTML: () => [{ tag: "div[data-unused-footnote]", getAttrs: element => {
    try {
      const note = JSON.parse(element.getAttribute("data-definition") ?? "null");
      return note?.type === "footnoteDefinition" && typeof note.attrs?.label === "string" ? { label: note.attrs.label, definition: note } : false;
    } catch { return false; }
  } }],
  renderHTML: ({ node }) => ["div", { "data-unused-footnote": "", "data-definition": JSON.stringify(node.attrs.definition), hidden: "", style: "display:none" }],
  renderMarkdown: (node, helpers) => node.attrs?.definition ? renderFootnote(node.attrs.definition, helpers) : "",
});

export const FootnoteOrder = Extension.create({
  name: "footnoteOrder",
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(transactions, previous, state) {
        if (!transactions.some(tr => tr.docChanged)) return;
        const oldNumbers = footnoteNumbers(previous.doc);
        const currentNumbers = footnoteNumbers(state.doc);
        const loading = transactions.some(tr => tr.getMeta("preventUpdate"));
        const entries: { pos: number; original: DocumentNode; node: DocumentNode; index: number }[] = [];
        const body: DocumentNode[] = [];
        state.doc.forEach((node, pos, index) => {
          const note = definition(node);
          if (!note) { body.push(node); return; }
          const label = footnoteKey(note.attrs.label);
          if (!loading && oldNumbers.has(label) && !currentNumbers.has(label)) {
            entries.push({ pos, original: node, node: state.schema.nodes.unusedFootnote!.create({ label, definition: null }), index });
            return;
          }
          const replacement = currentNumbers.has(label) ? note : state.schema.nodes.unusedFootnote!.create({ label: note.attrs.label, definition: footnoteSnapshot(note) });
          entries.push({ pos, original: node, node: replacement, index });
        });
        const notes = entries.filter(entry => entry.node.type.name !== "unusedFootnote" || entry.node.attrs.definition);
        const labels = new Set(notes.map(entry => footnoteKey(entry.node.attrs.label)));
        const counts = (doc: DocumentNode) => {
          const result = new Map<string, number>();
          doc.descendants(node => { if (node.type.name === "footnoteReference") { const label = footnoteKey(node.attrs.label); result.set(label, (result.get(label) ?? 0) + 1); } });
          return result;
        };
        const oldCounts = counts(previous.doc), newCounts = counts(state.doc);
        // A cut/pasted reference carries its note in the internal HTML clipboard.
        // A plain Markdown reference with no definition stays unresolved instead.
        state.doc.descendants(node => {
          if (node.type.name !== "footnoteReference" || !node.attrs.definition || labels.has(footnoteKey(node.attrs.label))) return;
          if ((newCounts.get(footnoteKey(node.attrs.label)) ?? 0) <= (oldCounts.get(footnoteKey(node.attrs.label)) ?? 0)) return;
          try {
            const restored = state.schema.nodeFromJSON(node.attrs.definition);
            if (restored.type.name !== "footnoteDefinition" || footnoteKey(restored.attrs.label) !== footnoteKey(node.attrs.label)) return;
            notes.push({ pos: -1, original: restored, node: restored, index: state.doc.childCount + notes.length });
            labels.add(footnoteKey(restored.attrs.label));
          } catch { /* Untrusted or incompatible clipboard payload. */ }
        });
        notes.sort((a, b) => (currentNumbers.get(footnoteKey(a.node.attrs.label)) ?? Infinity) - (currentNumbers.get(footnoteKey(b.node.attrs.label)) ?? Infinity) || a.index - b.index);
        if (notes.length && body.every(node => node.isAtom)) body.push(state.schema.nodes.paragraph!.create());
        const desired = Fragment.fromArray([...body, ...notes.map(entry => entry.node)]);
        const tr = state.tr;
        if (!desired.eq(state.doc.content)) {
          const selection = state.selection;
          const anchorEntry = entries.find(entry => selection.anchor > entry.pos && selection.anchor < entry.pos + entry.original.nodeSize);
          const headEntry = entries.find(entry => selection.head > entry.pos && selection.head < entry.pos + entry.original.nodeSize);
          for (const entry of [...entries].reverse()) tr.delete(entry.pos, entry.pos + entry.original.nodeSize);
          if (body.length && tr.doc.content.size === 0) tr.insert(0, Fragment.fromArray(body));
          else if (body.length > tr.doc.childCount) tr.insert(tr.doc.content.size, state.schema.nodes.paragraph!.create());
          const positions = new Map<DocumentNode, number>();
          for (const entry of notes) {
            positions.set(entry.original, tr.doc.content.size);
            tr.insert(tr.doc.content.size, entry.node);
          }
          const mapPosition = (pos: number, entry: typeof anchorEntry) => {
            const next = entry && positions.get(entry.original);
            return next !== undefined && entry && entry.node.type.name === "footnoteDefinition" ? next + Math.min(pos - entry.pos, entry.node.nodeSize - 1) : tr.mapping.map(pos);
          };
          if (selection instanceof TextSelection) tr.setSelection(TextSelection.between(tr.doc.resolve(mapPosition(selection.anchor, anchorEntry)), tr.doc.resolve(mapPosition(selection.head, headEntry))));
        }
        const definitions = new Map<string, JSONContent>();
        tr.doc.descendants(node => { const note = definition(node); if (note && !definitions.has(footnoteKey(note.attrs.label))) { definitions.set(footnoteKey(note.attrs.label), footnoteSnapshot(note)); return false; } });
        tr.doc.descendants((node, pos) => {
          if (node.type.name !== "footnoteReference") return;
          const snapshot = definitions.get(footnoteKey(node.attrs.label)) ?? null;
          if (JSON.stringify(snapshot) !== JSON.stringify(node.attrs.definition)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, definition: snapshot });
        });
        if (!tr.docChanged) return;
        if (loading) tr.setMeta("preventUpdate", true);
        return tr;
      },
    })];
  },
});
