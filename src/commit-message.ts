const WORD = /[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(```|~~~)/;
// Past this many comparisons the exact diff is skipped for a cheaper count.
const MAX_CELLS = 4_000_000;
const MAX_SECTIONS = 3;

type Parsed = { words: string[]; section: number[]; labels: string[]; lineSection: number[] };

function cleanHeading(text: string) {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "").trim();
}

// Words in reading order, each tagged with the heading it sits under. Heading text
// belongs to the section it opens; text before the first heading is section 0.
function parse(text: string): Parsed {
  const labels = [""];
  const words: string[] = [];
  const section: number[] = [];
  const lineSection: number[] = [];
  let current = 0;
  let fenced = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : HEADING.exec(line);
    if (heading) {
      labels.push(cleanHeading(heading[1]));
      current = labels.length - 1;
    }
    lineSection.push(current);
    for (const word of line.replace(/\]\([^)\s]*\)/g, "]").match(WORD) ?? []) {
      words.push(word.toLowerCase());
      section.push(current);
    }
  }
  return { words, section, labels, lineSection };
}

type Edit = { deleted: number[]; added: number[] };

// Word indexes that were removed from `a` and added in `b`.
function diffWords(a: string[], b: string[]): Edit {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  const deleted: number[] = [];
  const added: number[] = [];
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    // Too big to align exactly: a word counts as changed when its count differs.
    const spare = new Map<string, number>();
    for (let i = start; i < endB; i++) spare.set(b[i], (spare.get(b[i]) ?? 0) + 1);
    for (let i = start; i < endA; i++) {
      const left = spare.get(a[i]) ?? 0;
      if (left > 0) spare.set(a[i], left - 1);
      else deleted.push(i);
    }
    const kept = new Map<string, number>();
    for (let i = start; i < endA; i++) kept.set(a[i], (kept.get(a[i]) ?? 0) + 1);
    for (let j = start; j < endB; j++) {
      const left = kept.get(b[j]) ?? 0;
      if (left > 0) kept.set(b[j], left - 1);
      else added.push(j);
    }
    return { deleted, added };
  }
  // lcs[i][j]: longest common run of a[start+i..] and b[start+j..].
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * width + j] =
        a[start + i] === b[start + j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) deleted.push(start + i++);
    else added.push(start + j++);
  }
  while (i < n) deleted.push(start + i++);
  while (j < m) added.push(start + j++);
  return { deleted, added };
}

const count = (n: number) => `${n} ${n === 1 ? "word" : "words"}`;
const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A commit message that needs no model: how many words went away and came in,
 * and under which heading. `before` is null for a file that was never committed.
 */
export function summarizeChanges(before: string | null, after: string, fileName: string): string {
  const next = parse(after);
  if (before === null) return `Add ${fileName} (${count(next.words.length)})`;
  if (before === after) return "No changes";
  const prev = parse(before);
  const edit = diffWords(prev.words, next.words);
  const titled = prev.labels.length > 1 || next.labels.length > 1;
  const place = (label: string) => (!titled ? "" : ` in ${label === "" ? "the opening" : label}`);

  const totals = new Map<string, { deleted: number; added: number }>();
  const tally = (label: string, key: "deleted" | "added") => {
    const entry = totals.get(label) ?? { deleted: 0, added: 0 };
    entry[key]++;
    totals.set(label, entry);
  };
  // Removed words are placed under the heading they had; added words under the new one.
  edit.deleted.forEach(i => tally(prev.labels[prev.section[i]], "deleted"));
  edit.added.forEach(j => tally(next.labels[next.section[j]], "added"));

  if (totals.size === 0) {
    const a = before.split("\n");
    const b = after.split("\n");
    let line = 0;
    while (line < a.length && line < b.length && a[line] === b[line]) line++;
    const label = next.labels[next.lineSection[Math.min(line, next.lineSection.length - 1)]];
    return `Edit formatting${place(label)}`;
  }

  const ranked = [...totals].sort((x, y) => y[1].deleted + y[1].added - (x[1].deleted + x[1].added));
  const shown = ranked.slice(0, MAX_SECTIONS).map(([label, { deleted, added }]) => {
    const what =
      deleted && added ? `deleted ${count(deleted)} and added ${added}` : deleted ? `deleted ${count(deleted)}` : `added ${count(added)}`;
    return what + place(label);
  });
  const more = ranked.length - shown.length;
  if (more > 0) shown.push(`${more} more ${more === 1 ? "section" : "sections"}`);
  return upper(shown.join("; "));
}
