import { expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { extensions } from "../src/extensions";
import { buildScript, charAt, documentRange, wordAt, wordIndexAt } from "../src/speech-script";
import { pieces } from "../src/speech-language";
import { charStarts, sanitize } from "../src/speech";

const schema = getSchema(extensions);
const text = (value: string) => ({ type: "text", text: value });
const paragraph = (value: string) => ({ type: "paragraph", content: [text(value)] });
const doc = (...content: object[]) => schema.nodeFromJSON({ type: "doc", content });

test("reads headings, paragraphs, list items and table cells, each ending in a stop", () => {
  const script = buildScript(doc(
    { type: "heading", attrs: { level: 1 }, content: [text("Plan")] },
    paragraph("First point."),
    { type: "bulletList", content: [{ type: "listItem", content: [paragraph("Buy milk")] }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph("Cell")] }] }] },
  ));
  expect(script.text).toBe("Plan. First point. Buy milk. Cell.");
  expect(script.blocks.length).toBe(4);
  expect(script.sentences.map(range => script.text.slice(range.start, range.end))).toEqual(["Plan.", "First point.", "Buy milk.", "Cell."]);
});

test("every spoken word maps back to the same text in the document", () => {
  const source = doc(
    paragraph("Hello brave world. Second sentence here."),
    { type: "paragraph", content: [text("Bold "), { type: "text", text: "link", marks: [{ type: "bold" }] }, text(" label.")] },
  );
  const script = buildScript(source);
  for (const word of script.words) {
    const range = documentRange(script, word);
    expect(source.textBetween(range.from, range.to)).toBe(script.text.slice(word.start, word.end));
  }
  expect(script.text).toBe("Hello brave world. Second sentence here. Bold link label.");
});

test("skips code, footnote bodies, comments, URLs, identifiers and path prefixes", () => {
  const script = buildScript(doc(
    paragraph("See https://example.com/a for commit 3f9a2c71b8d4 in /Users/m/Code/app/main.ts:12-20 today."),
    { type: "codeBlock", content: [text("const secret = 1;")] },
    { type: "footnoteDefinition", attrs: { label: "a" }, content: [paragraph("Footnote body.")] },
    { type: "htmlComment", attrs: { source: "<!-- hidden -->", id: "c1" } },
    paragraph("client -> server"),
  ));
  expect(script.text).toBe("See for commit in main.ts today. client to server.");
});

test("reading a selection or from a caret only speaks characters in that range", () => {
  const source = doc(paragraph("Alpha beta gamma."), paragraph("Delta epsilon."));
  const full = buildScript(source);
  const from = full.pos[full.words[1].start];
  expect(buildScript(source, from).text).toBe("beta gamma. Delta epsilon.");
  const to = full.pos[full.words[2].end - 1] + 1;
  expect(buildScript(source, from, to).text).toBe("beta gamma.");
  expect(buildScript(source, source.content.size, source.content.size).words).toEqual([]);
});

test("finds the word at a document position and the word being spoken at a time", () => {
  const source = doc(paragraph("One two three four."));
  const script = buildScript(source);
  const two = script.words[1];
  expect(wordIndexAt(script, charAt(script, script.pos[two.start] + 1))).toBe(1);
  const starts = Array.from({ length: script.text.length }, (_, index) => {
    const word = script.words.findIndex(candidate => candidate.end > index);
    return word * 0.5;
  });
  expect(wordAt(script, 0, starts, 0)).toBe(0);
  expect(wordAt(script, 0, starts, 0.99)).toBe(1);
  expect(wordAt(script, 0, starts, 10)).toBe(3);
  expect(wordAt(script, 0, starts, -1)).toBe(-1);
});

test("word times follow Speechify's code point marks, including past emoji", () => {
  const input = "Hi 😀 there";
  const starts = charStarts(input, [{ start: 0, end: 2, start_time: 0 }, { start: 5, end: 10, start_time: 800 }]);
  expect(starts.length).toBe(input.length);
  expect(starts[0]).toBe(0);
  expect(starts[input.indexOf("there")]).toBe(0.8);
  expect(starts.at(-1)).toBe(0.8);
  expect(sanitize(input)).toBe("Hi   there");
  expect([...sanitize(input)].length).toBe([...input].length);
});

test("language pieces cover the script exactly and switch to German for German sentences", () => {
  const script = buildScript(doc(
    paragraph("This is an English introduction."),
    paragraph("Sehr geehrter Herr Happe, ich interessiere mich für Ihre Inhalte."),
  ));
  const ranges = pieces(script.text, script.blocks);
  expect(ranges.map(range => script.text.slice(range.start, range.end)).join("")).toBe(script.text);
  expect(ranges.map(range => range.language)).toEqual(["en", "de"]);
});
