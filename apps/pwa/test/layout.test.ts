import { describe, expect, it } from "vitest";
import type { PostView } from "../src/lib/engine.ts";
import { groupByHour, justify } from "../src/lib/layout.ts";

const P = 9 / 16;
const L = 16 / 9;
const opt = { gap: 4, target: 200, maxHeight: 520 };
const W = 360;

/** 行の幅（gap 込み）。grow の比で配るので、切り取りがなければ高さ × 縦横比の合計 */
const rowWidth = (r: ReturnType<typeof justify>[number], aspects: number[]) =>
  r.items.reduce((s, it) => s + aspects[it.index]! * r.height, 0) + opt.gap * (r.items.length - 1);

describe("justify", () => {
  it("順番を保ってすべてを 1 回ずつ並べる", () => {
    const a = [P, L, P, P, L, P, P];
    const rows = justify(a, W, opt);
    expect(rows.flatMap((r) => r.items.map((it) => it.index))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it("切り取らない行は幅いっぱいになる", () => {
    const a = [P, P, P, L, P, P];
    for (const r of justify(a, W, opt)) if (r.height < opt.maxHeight) expect(rowWidth(r, a)).toBeCloseTo(W);
  });
  it("横長は 1 本で 1 行、縦長は 3 本で 1 行に近い高さを選ぶ", () => {
    expect(justify([L], W, opt).map((r) => r.items.length)).toEqual([1]);
    expect(justify([P, P, P], W, opt).map((r) => r.items.length)).toEqual([3]);
  });
  it("縦長 1 本だけなら高さを抑えて切り取る", () => {
    const [r] = justify([P], W, opt);
    expect(r!.height).toBe(opt.maxHeight);
  });
  it("空なら何も返さない", () => {
    expect(justify([], W, opt)).toEqual([]);
  });
});

describe("groupByHour", () => {
  const post = (id: string, h: number, m = 0) => ({ id, ts: new Date(2026, 9, 17, h, m).getTime() }) as unknown as PostView;
  it("時間ごとに古い順でまとめる", () => {
    const pages = groupByHour([post("c", 10, 5), post("a", 9, 30), post("b", 9, 10)]);
    expect(pages.map((p) => p.posts.map((x) => x.id))).toEqual([["b", "a"], ["c"]]);
  });
});
