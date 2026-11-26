/** One line of a run of text, as a box: its left, right, top and bottom. */
export type Row = { l: number; r: number; t: number; b: number };

/** Lines whose edges are closer than this are one block; further apart they are separate shapes. */
const TOUCH = 3;

/**
 * One outline around every line of a run of text, top line first: straight where two lines
 * meet, round at each corner that is left, the inward ones too. Lines that do not overlap by
 * two corners' width (a sentence ending one line and starting the next) are each their own
 * round box, not joined through a neck.
 */
export function pathOf(lines: Row[], radius: number): string {
  const rows = lines.map(o => ({ ...o }));
  const groups: Row[][] = [];
  for (const o of rows) {
    const last = groups[groups.length - 1];
    const above = last?.[last.length - 1];
    const stacked = above && Math.abs(o.t - above.b) < TOUCH;
    if (above && stacked && Math.min(above.r, o.r) - Math.max(above.l, o.l) >= 2 * radius) {
      // A line ends where the next begins, so no hairline of page shows between them.
      above.b = o.t = (above.b + o.t) / 2;
      last.push(o);
    } else groups.push([o]);
  }
  return groups.map(group => outline(group, radius)).join("");
}

function outline(rows: Row[], radius: number): string {
  // Lines that start (or end) within a pixel of each other share one straight edge, not a sliver of a step.
  for (let i = 1; i < rows.length; i++) {
    const [a, b] = [rows[i - 1]!, rows[i]!];
    if (Math.abs(a.l - b.l) < 1) b.l = a.l;
    if (Math.abs(a.r - b.r) < 1) b.r = a.r;
  }
  // Down the right side, back up the left.
  const all: [number, number][] = [];
  for (const o of rows) all.push([o.r, o.t], [o.r, o.b]);
  for (const o of [...rows].reverse()) all.push([o.l, o.b], [o.l, o.t]);
  const distinct = all.filter(([x, y], i) => {
    const [px, py] = all[(i + all.length - 1) % all.length]!;
    return Math.abs(x - px) > 0.5 || Math.abs(y - py) > 0.5;
  });
  // A point midway along a straight edge (two flush lines meeting) is no corner.
  const points = distinct.filter(([x, y], i) => {
    const [px, py] = distinct[(i + distinct.length - 1) % distinct.length]!;
    const [nx, ny] = distinct[(i + 1) % distinct.length]!;
    return !((x === px && x === nx) || (y === py && y === ny));
  });
  if (points.length < 4) return "";
  const n = (v: number) => Math.round(v * 100) / 100;
  let d = "";
  points.forEach(([x, y], i) => {
    const [ax, ay] = points[(i + points.length - 1) % points.length]!;
    const [bx, by] = points[(i + 1) % points.length]!;
    const before = Math.hypot(ax - x, ay - y);
    const after = Math.hypot(bx - x, by - y);
    // A step smaller than two corners gets smaller corners.
    const r = Math.min(radius, before / 2, after / 2);
    const sx = x + ((ax - x) / before) * r;
    const sy = y + ((ay - y) / before) * r;
    const ex = x + ((bx - x) / after) * r;
    const ey = y + ((by - y) / after) * r;
    d += `${i ? "L" : "M"}${n(sx)} ${n(sy)}Q${n(x)} ${n(y)} ${n(ex)} ${n(ey)}`;
  });
  return `${d}Z`;
}
