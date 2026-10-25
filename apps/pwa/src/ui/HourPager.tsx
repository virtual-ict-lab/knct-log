import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Film, Hourglass, Lock, MessageCircle } from "lucide-react";
import type { PostView } from "../lib/engine.ts";
import { aspectOf, groupByHour, justify, type HourPage } from "../lib/layout.ts";
import { TextOverlay, useClipUrl } from "./GroupPage.tsx";
import { Avatar, IconButton, Spinner } from "./common.tsx";
import { dayKey, formatDay, formatTime, useEngine } from "./hooks.ts";

const GAP = 4;

/**
 * 1 時間を 1 ページにして横にめくる。最初は最新の時間を開く。
 * ページの中は縦長・横長の動画を隙間なく並べる。前後のページだけ中身を作る。
 */
export function HourPager({ posts, onOpen, onVlog }: { posts: PostView[]; onOpen: (id: string) => void; onVlog: (day: PostView[]) => void }) {
  const pages = useMemo(() => groupByHour(posts), [posts]);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // 開いているページは時間のキーで覚える（新しい投稿でページが増えてもずれない）。null は最新
  const [current, setCurrent] = useState<string | null>(null);
  const currentRef = useRef(current);
  currentRef.current = current;
  // 旧投稿は縦横比が書かれていないので、読み込んだ動画の大きさで並べ直す
  const [measured, setMeasured] = useState<Map<string, number>>(new Map());

  const found = pages.findIndex((p) => p.key === current);
  const index = found < 0 ? pages.length - 1 : found;
  const page = pages[index];
  const engine = useEngine();

  // 開いているページの投稿は見たことにする（ほかの時間の未読は丸の色でわかる）
  useEffect(() => {
    if (page) engine.markSeen(page.posts[0]!.group, page.posts).catch(console.error);
  }, [engine, page]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ページが増えたり画面が回転したりしたら、開いていたページに合わせ直す
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !width) return;
    const i = pages.findIndex((p) => p.key === currentRef.current);
    const left = (i < 0 ? pages.length - 1 : i) * el.clientWidth;
    if (Math.abs(el.scrollLeft - left) > 1) el.scrollLeft = left;
  }, [pages, width]);

  const onScroll = () => {
    const el = ref.current;
    if (!el || !el.clientWidth) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    const key = i >= pages.length - 1 ? null : (pages[i]?.key ?? null);
    if (key !== currentRef.current) setCurrent(key);
  };
  const goTo = (i: number) => ref.current?.scrollTo({ left: i * ref.current.clientWidth, behavior: "smooth" });

  const day = page ? dayKey(page.ts) : null;
  const sameDay = pages.map((p, i) => ({ p, i })).filter(({ p }) => dayKey(p.ts) === day);
  const dayPosts = posts.filter((p) => dayKey(p.ts) === day);

  return (
    <>
      {page && (
        <div className="hour-head">
          <div className="hour-label">
            <h2>{formatDay(page.ts)}</h2>
            <span>{new Date(page.ts).getHours()}:00</span>
          </div>
          <IconButton icon={Film} label="まとめる" disabled={!dayPosts.some((p) => p.content)} onClick={() => onVlog(dayPosts)} />
        </div>
      )}
      {sameDay.length > 1 && (
        <div className="hour-dots">
          {sameDay.map(({ p, i }) => (
            <button
              key={p.key}
              className={i === index ? "on" : p.posts.some((x) => x.unread) ? "unread" : ""}
              aria-label={`${new Date(p.ts).getHours()}:00`}
              onClick={() => goTo(i)}
            />
          ))}
        </div>
      )}
      <div className="hour-pager" ref={ref} onScroll={onScroll}>
        {pages.map((p, i) => (
          <section key={p.key} className="hour-page" data-day={i === 0 || dayKey(pages[i - 1]!.ts) !== dayKey(p.ts) ? dayKey(p.ts) : undefined}>
            {Math.abs(i - index) <= 1 && width > 0 && (
              <HourGrid
                page={p}
                width={width}
                measured={measured}
                onMeasure={(id, a) => setMeasured((m) => (m.get(id) === a ? m : new Map(m).set(id, a)))}
                onOpen={onOpen}
              />
            )}
          </section>
        ))}
      </div>
    </>
  );
}

function HourGrid(props: { page: HourPage; width: number; measured: Map<string, number>; onMeasure: (id: string, aspect: number) => void; onOpen: (id: string) => void }) {
  const { posts } = props.page;
  const aspects = posts.map((p) => props.measured.get(p.id) ?? aspectOf(p));
  const rows = justify(aspects, props.width, {
    gap: GAP,
    target: Math.min(props.width * 0.58, innerHeight * 0.4),
    maxHeight: innerHeight * 0.7,
  });
  return (
    <div className="hour-grid">
      {rows.map((r) => (
        <div key={r.items[0]!.index} className="hour-row" style={{ height: r.height }}>
          {r.items.map(({ index, grow }) => {
            const p = posts[index]!;
            return (
              <ClipCard
                key={p.id}
                post={p}
                grow={grow}
                onOpen={() => props.onOpen(p.id)}
                onMeasure={p.content?.w ? undefined : (a) => props.onMeasure(p.id, a)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ClipCard({ post, grow, onOpen, onMeasure }: { post: PostView; grow: number; onOpen: () => void; onMeasure?: (aspect: number) => void }) {
  const { url, failed, ref } = useClipUrl(post);
  return (
    <div className="clip" ref={ref} style={{ flexGrow: grow }} onClick={onOpen} role="button" aria-label={`${post.authorName ?? ""} ${formatTime(post.ts)}`}>
      {url ? (
        <video
          src={url}
          playsInline
          muted
          loop
          autoPlay
          onLoadedMetadata={(e) => e.currentTarget.videoHeight && onMeasure?.(e.currentTarget.videoWidth / e.currentTarget.videoHeight)}
        />
      ) : (
        <div className="clip-placeholder">{failed || !post.content ? <Lock size={22} /> : <Spinner size={22} />}</div>
      )}
      <TextOverlay text={post.content?.text} />
      <div className="clip-meta">
        <Avatar id={post.author} name={post.authorName} size={22} />
        <span>{post.pending ? <Hourglass size={14} /> : formatTime(post.ts)}</span>
      </div>
      {(post.reactions.length > 0 || post.replies.length > 0) && (
        <div className="clip-reactions">
          {post.reactions.slice(0, 3).map((r) => (
            <span key={r.emoji} className={r.mine ? "mine" : ""}>
              {r.emoji}
              {r.count > 1 && <small>{r.count}</small>}
            </span>
          ))}
          {post.replies.length > 0 && (
            <span>
              <MessageCircle size={13} />
              <small>{post.replies.length}</small>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
