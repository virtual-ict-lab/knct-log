import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { PostView } from "../lib/engine.ts";
import { countByDay, dayKeyOf, monthCells } from "../lib/timeline.ts";
import { IconButton, Sheet } from "./common.tsx";
import "./group.css";

const DOW = ["日", "月", "火", "水", "木", "金", "土"];

/** 投稿のある日は日付の下に丸が付き、未読があると色が変わる。日をタップするとその日へ */
export function CalendarSheet({ posts, onPick, onClose }: { posts: PostView[]; onPick: (key: string) => void; onClose: () => void }) {
  const counts = useMemo(() => countByDay(posts), [posts]);
  const unread = useMemo(() => new Set(posts.filter((p) => p.unread).map((p) => dayKeyOf(p.ts))), [posts]);
  const [ym, setYm] = useState(() => ({ y: new Date().getFullYear(), m: new Date().getMonth() }));
  const shift = (n: number) =>
    setYm(({ y, m }) => {
      const d = new Date(y, m + n, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  const today = dayKeyOf(Date.now());
  const title = new Date(ym.y, ym.m, 1).toLocaleDateString("ja-JP", { year: "numeric", month: "long" });

  return (
    <Sheet onClose={onClose}>
      <div className="cal-head">
        <IconButton icon={ChevronLeft} label="前の月" onClick={() => shift(-1)} />
        <h2>{title}</h2>
        <IconButton icon={ChevronRight} label="次の月" onClick={() => shift(1)} />
      </div>
      <div className="cal-grid">
        {DOW.map((d) => (
          <span key={d} className="cal-dow">
            {d}
          </span>
        ))}
        {monthCells(ym.y, ym.m).map((day, i) => {
          if (day === null) return <span key={i} />;
          const key = `${ym.y}-${ym.m + 1}-${day}`;
          const n = counts.get(key) ?? 0;
          return (
            <button key={i} className={`cal-cell ${n ? "has" : ""} ${key === today ? "today" : ""} ${unread.has(key) ? "unread" : ""}`} data-day={key} disabled={!n} onClick={() => onPick(key)} aria-label={`${ym.m + 1}/${day}${n ? ` ${n}` : ""}`}>
              {day}
              {n > 0 && <i className="cal-dot" />}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
