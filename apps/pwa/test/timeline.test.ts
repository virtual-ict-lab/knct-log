import { describe, expect, it } from "vitest";
import type { PostView } from "../src/lib/engine.ts";
import { buildTimeline, countByDay, monthCells } from "../src/lib/timeline.ts";

const post = (id: string, ts: number, replies: number[] = []): PostView =>
  ({ id, ts, author: "a", replies: replies.map((t, i) => ({ id: `${id}r${i}`, author: "b", authorName: null, text: "x", ts: t })) }) as unknown as PostView;
const d = (day: number, h = 12) => new Date(2026, 9, day, h).getTime();

describe("timeline", () => {
  it("動画と返信を古い順に並べ、日付を挟む", () => {
    const t = buildTimeline([post("p2", d(2)), post("p1", d(1), [d(1, 13), d(2, 13)])]);
    expect(t.map((x) => (x.type === "day" ? "day" : x.type === "clip" ? x.post.id : x.id))).toEqual(["day", "p1", "p1r0", "day", "p2", "p1r1"]);
  });
  it("日ごとに数える", () => {
    const m = countByDay([post("a", d(1)), post("b", d(1, 20)), post("c", d(3))]);
    expect([...m.values()]).toEqual([2, 1]);
  });
  it("月の並び（2026年10月は木曜始まり・31日）", () => {
    const c = monthCells(2026, 9);
    expect(c.length % 7).toBe(0);
    expect(c.indexOf(1)).toBe(4);
    expect(c.filter(Boolean).length).toBe(31);
  });
});
