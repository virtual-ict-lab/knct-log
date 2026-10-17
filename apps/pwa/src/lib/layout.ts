import type { PostView } from "./engine.ts";

/** 投稿に書かれた動画の縦横比（幅 / 高さ）。書かれていない旧投稿は縦長 9:16 とみなす */
export function aspectOf(post: PostView): number {
  const c = post.content;
  return c?.w && c.h ? c.w / c.h : 9 / 16;
}

export function hourKeyOf(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}-${d.getHours()}`;
}

export interface HourPage {
  key: string;
  /** その時間の最初の投稿の時刻 */
  ts: number;
  posts: PostView[];
}

/** 1 時間ごとにまとめる。ページは古い順、ページの中も古い順 */
export function groupByHour(posts: PostView[]): HourPage[] {
  const m = new Map<string, PostView[]>();
  for (const p of [...posts].sort((a, b) => a.ts - b.ts)) {
    const k = hourKeyOf(p.ts);
    (m.get(k) ?? m.set(k, []).get(k)!).push(p);
  }
  return [...m].map(([key, ps]) => ({ key, ts: ps[0]!.ts, posts: ps }));
}

export interface Row {
  height: number;
  /** 行の中の幅の比。合計で行の幅いっぱいになる */
  items: { index: number; grow: number }[];
}

/** 引き伸ばして切り取るときの重み。目標の高さからずれるより切り取る方を強く避ける */
const CROP_WEIGHT = 8;

/**
 * 縦長と横長が混ざった動画を、行ごとに高さをそろえて幅いっぱいに隙間なく並べる。
 * 並び順は変えず、行の分け方を「目標の高さからのずれ」と「切り取る量」の合計が最小になるように選ぶ。
 * 行の高さが maxHeight を超えるときは maxHeight にして横に引き伸ばし、はみ出た分は object-fit: cover で切る。
 */
export function justify(aspects: number[], width: number, opt: { gap: number; target: number; maxHeight: number }): Row[] {
  const n = aspects.length;
  if (n === 0 || width <= 0) return [];
  const row = (i: number, j: number) => {
    const avail = width - opt.gap * (j - i - 1);
    let sum = 0;
    for (let k = i; k < j; k++) sum += aspects[k]!;
    const natural = avail / sum;
    const height = Math.min(natural, opt.maxHeight);
    const stretch = natural / height;
    // 本数で掛けて、1 行に詰め込みすぎて小さくなるのを避ける
    const cost = (j - i) * (Math.log(height / opt.target) ** 2 + CROP_WEIGHT * (stretch - 1) ** 2);
    return { height, cost };
  };
  const best = new Array<number>(n + 1).fill(Infinity);
  const from = new Array<number>(n + 1).fill(0);
  best[0] = 0;
  for (let j = 1; j <= n; j++)
    for (let i = 0; i < j; i++) {
      const c = best[i]! + row(i, j).cost;
      if (c < best[j]!) [best[j], from[j]] = [c, i];
    }
  const rows: Row[] = [];
  for (let j = n; j > 0; j = from[j]!) {
    const i = from[j]!;
    const items = [];
    for (let k = i; k < j; k++) items.push({ index: k, grow: aspects[k]! });
    rows.unshift({ height: row(i, j).height, items });
  }
  return rows;
}
