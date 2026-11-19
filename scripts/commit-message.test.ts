import { expect, test } from "bun:test";
import { summarizeChanges } from "../src/commit-message";

const doc = (intro: string, pricing = "Pricing text stays.") => `# Guide\n\n${intro}\n\n## Pricing\n\n${pricing}\n`;

test("counts deleted and added words under the heading above the change", () => {
  const before = doc("One two three four five six seven.");
  const after = doc("One two three eight nine ten eleven twelve thirteen.");
  expect(summarizeChanges(before, after, "a.md")).toBe("Deleted 4 words and added 6 in Guide");
});

test("names each section that changed, using the heading where words were removed or added", () => {
  const before = doc("Same intro.", "Old price list.");
  const after = doc("Same intro. Plus more words.", "Old list.");
  expect(summarizeChanges(before, after, "a.md")).toBe("Added 3 words in Guide; deleted 1 word in Pricing");
});

test("singular, additions only and deletions only", () => {
  expect(summarizeChanges(doc("Hello."), doc("Hello there."), "a.md")).toBe("Added 1 word in Guide");
  expect(summarizeChanges(doc("Hello there."), doc("Hello."), "a.md")).toBe("Deleted 1 word in Guide");
});

test("omits the section for a document without headings and names the opening before the first heading", () => {
  expect(summarizeChanges("one two three\n", "one three four five\n", "a.md")).toBe("Deleted 1 word and added 2");
  expect(summarizeChanges("Intro line.\n\n# H\n\nBody.\n", "Intro line now.\n\n# H\n\nBody.\n", "a.md")).toBe("Added 1 word in the opening");
});

test("headings in code fences are not sections", () => {
  const before = "# Real\n\n```sh\n# comment\n```\n";
  const after = "# Real\n\n```sh\n# comment changed\n```\n";
  expect(summarizeChanges(before, after, "a.md")).toBe("Added 1 word in Real");
});

test("link targets and markup do not count as words", () => {
  expect(summarizeChanges("See [the docs](https://a.example/x).\n", "See [the docs](https://b.example/y).\n", "a.md")).toBe("Edit formatting");
  expect(summarizeChanges("# T\n\nA *b* c.\n", "# T\n\nA b c.\n", "a.md")).toBe("Edit formatting in T");
});

test("limits the message to the busiest sections", () => {
  const sections = (extra: number[]) => extra.map((n, i) => `## S${i}\n\n${"w ".repeat(n)}\n`).join("\n");
  const before = sections([1, 1, 1, 1, 1]);
  const after = sections([2, 4, 6, 3, 5]);
  expect(summarizeChanges(before, after, "a.md")).toBe("Added 5 words in S2; added 4 words in S4; added 3 words in S1; 2 more sections");
});

test("a new file is described by name and length, an unchanged file says so", () => {
  expect(summarizeChanges(null, "# T\n\nOne two three.\n", "note.md")).toBe("Add note.md (4 words)");
  expect(summarizeChanges("x\n", "x\n", "a.md")).toBe("No changes");
});

test("a large rewrite still finishes with totals", () => {
  const words = (prefix: string) => Array.from({ length: 3000 }, (_, i) => `${prefix}${i}`).join(" ");
  const started = performance.now();
  const message = summarizeChanges(`# Big\n\n${words("a")}\n`, `# Big\n\n${words("b")}\n`, "a.md");
  expect(message).toBe("Deleted 3000 words and added 3000 in Big");
  expect(performance.now() - started).toBeLessThan(3000);
});
