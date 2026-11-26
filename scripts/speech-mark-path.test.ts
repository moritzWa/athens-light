import { expect, test } from "bun:test";
import { pathOf, type Row } from "../src/speech-mark-path";

/** Each corner of a path as its control point and the curve's two ends: `L sx sy Q x y ex ey`. */
function corners(d: string) {
  const out: { at: [number, number]; from: [number, number]; to: [number, number] }[] = [];
  for (const m of d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)Q(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/g)) {
    const [sx, sy, x, y, ex, ey] = m.slice(1).map(Number) as [number, number, number, number, number, number];
    out.push({ at: [x, y], from: [sx, sy], to: [ex, ey] });
  }
  return out;
}
const at = (d: string, x: number, y: number) => corners(d).find(c => c.at[0] === x && c.at[1] === y);
const round = (c: ReturnType<typeof at>) => !!c && (c.from[0] !== c.at[0] || c.from[1] !== c.at[1]) && (c.to[0] !== c.at[0] || c.to[1] !== c.at[1]);

test("a single line is one box, round at all four corners", () => {
  const d = pathOf([{ l: -4, r: 120, t: 0, b: 20 }], 6);
  for (const [x, y] of [[-4, 0], [120, 0], [120, 20], [-4, 20]] as const) expect(round(at(d, x, y))).toBe(true);
  expect(at(d, -4, 20)!.to).toEqual([-4, 14]);
});

test("stacked lines make one shape: no corner where flush edges meet, round steps elsewhere", () => {
  const d = pathOf([
    { l: 60, r: 300, t: 0, b: 20 },
    { l: -4, r: 300, t: 20, b: 40 },
    { l: -4, r: 290, t: 40, b: 60 },
    { l: -4, r: 80, t: 60, b: 80 },
  ], 6);
  expect(d.match(/M/g)?.length).toBe(1);
  expect(round(at(d, -4, 80))).toBe(true);
  expect(round(at(d, -4, 20))).toBe(true);
  expect(round(at(d, 60, 20))).toBe(true);
  expect(at(d, -4, 40)).toBeUndefined();
  expect(at(d, -4, 60)).toBeUndefined();
  expect(round(at(d, 290, 40)) && round(at(d, 300, 40))).toBe(true);
  expect(round(at(d, 80, 60)) && round(at(d, 290, 60))).toBe(true);
});

test("a gap between lines (a smaller line height) is closed, not left as a hairline", () => {
  const d = pathOf([{ l: 0, r: 200, t: 0, b: 19 }, { l: 0, r: 200, t: 21, b: 40 }], 6);
  expect(d.match(/M/g)?.length).toBe(1);
  expect(at(d, 0, 20)).toBeUndefined();
});

test("lines that barely overlap are two round boxes, not one shape with a neck", () => {
  const d = pathOf([{ l: 250, r: 300, t: 0, b: 20 }, { l: -4, r: 254, t: 20, b: 40 }], 6);
  expect(d.match(/M/g)?.length).toBe(2);
  for (const [x, y] of [[250, 0], [300, 0], [300, 20], [250, 20], [-4, 20], [254, 20], [254, 40], [-4, 40]] as const) expect(round(at(d, x, y))).toBe(true);
});

test("lines far apart (separate blocks) stay separate shapes", () => {
  const rows: Row[] = [{ l: 0, r: 200, t: 0, b: 20 }, { l: 0, r: 200, t: 40, b: 60 }];
  expect(pathOf(rows, 6).match(/M/g)?.length).toBe(2);
});

test("left edges a fraction of a pixel apart are one straight edge", () => {
  const d = pathOf([{ l: -4, r: 300, t: 0, b: 20 }, { l: -3.6, r: 100, t: 20, b: 40 }], 6);
  expect(corners(d).filter(c => c.at[0] === -3.6).length).toBe(0);
  expect(at(d, -4, 40)!.to).toEqual([-4, 34]);
});
