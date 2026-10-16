import type { PostView } from "./engine.ts";

export function dayKeyOf(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export type TimelineItem =
  | { type: "day"; key: string; ts: number }
  | { type: "clip"; ts: number; post: PostView }
  | { type: "reply"; ts: number; id: string; author: string; authorName: string | null; text: string; to: PostView };

/** 動画と返信を時系列（古い順）に並べ、日が変わるところに日付を挟む */
export function buildTimeline(posts: PostView[]): TimelineItem[] {
  const items: Exclude<TimelineItem, { type: "day" }>[] = [];
  for (const p of posts) {
    items.push({ type: "clip", ts: p.ts, post: p });
    for (const r of p.replies) items.push({ type: "reply", ts: r.ts, id: r.id, author: r.author, authorName: r.authorName, text: r.text, to: p });
  }
  items.sort((a, b) => a.ts - b.ts);
  const out: TimelineItem[] = [];
  let last = "";
  for (const it of items) {
    const key = dayKeyOf(it.ts);
    if (key !== last) out.push({ type: "day", key, ts: it.ts });
    last = key;
    out.push(it);
  }
  return out;
}

/** 日ごとの投稿数 */
export function countByDay(posts: PostView[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of posts) m.set(dayKeyOf(p.ts), (m.get(dayKeyOf(p.ts)) ?? 0) + 1);
  return m;
}

/** 月のカレンダー。日曜始まり。月外の日は null */
export function monthCells(year: number, month: number): (number | null)[] {
  const lead = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  return cells;
}
