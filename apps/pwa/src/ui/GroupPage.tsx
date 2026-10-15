import { useEffect, useMemo, useRef, useState } from "react";
import type { PostView } from "../lib/engine.ts";
import { Screen } from "./Layout.tsx";
import { VlogDialog } from "./VlogDialog.tsx";
import { dayKey, formatDay, formatTime, go, useEngine, useLive } from "./hooks.ts";

export function GroupPage({ group }: { group: string }) {
  const view = useLive((e) => e.groupView(group), [group]);
  const posts = useLive((e) => e.posts(group), [group]);
  const posted = useLive((e) => e.postedThisHour(group), [group]);
  const [vlogDay, setVlogDay] = useState<PostView[] | null>(null);

  const days = useMemo(() => {
    const m = new Map<string, PostView[]>();
    for (const p of posts ?? []) (m.get(dayKey(p.ts)) ?? m.set(dayKey(p.ts), []).get(dayKey(p.ts))!).push(p);
    return [...m.values()];
  }, [posts]);

  if (!view) return <Screen title="" back="/">{null}</Screen>;

  const status = view.joining
    ? "参加を受け付け中です。サーバーに招待が届くと参加できます。"
    : !view.isMember
      ? "このグループのメンバーではありません。"
      : !view.hasKey
        ? "グループ鍵の受け取り待ちです。メンバーの誰かがアプリを開くと届きます。"
        : null;

  return (
    <Screen
      title={view.name ?? "…"}
      back="/"
      actions={
        view.isMember && (
          <button className="icon-btn" aria-label="グループ設定" onClick={() => go(`/g/${group}/settings`)}>
            ⋯
          </button>
        )
      }
    >
      {status && <div className="banner">{status}</div>}
      {view.isMember && view.hasKey && (
        <button className="btn primary wide" disabled={posted} onClick={() => go(`/capture?g=${group}`)}>
          {posted ? "この1時間はもう撮りました" : "● 今の1本を撮る"}
        </button>
      )}
      {days.length === 0 && view.hasKey && <p className="empty hint">まだクリップがありません。</p>}
      {days.map((day) => (
        <section key={dayKey(day[0]!.ts)} className="day">
          <div className="day-head">
            <h2>{formatDay(day[0]!.ts)}</h2>
            <button className="btn small" onClick={() => setVlogDay(day)} disabled={!day.some((p) => p.content)}>
              まとめる
            </button>
          </div>
          <div className="grid">
            {day.map((p) => (
              <PostCard key={p.id} post={p} />
            ))}
          </div>
        </section>
      ))}
      {vlogDay && <VlogDialog posts={vlogDay} onClose={() => setVlogDay(null)} />}
    </Screen>
  );
}

function PostCard({ post }: { post: PostView }) {
  const engine = useEngine();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // 画面に入ったら取得・復号する
  useEffect(() => {
    if (!post.content || url) return;
    const el = ref.current;
    if (!el) return;
    let objectUrl: string | null = null;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      io.disconnect();
      engine.video(post).then(
        (b) => setUrl((objectUrl = URL.createObjectURL(b))),
        (e) => setError((e as Error).message),
      );
    });
    io.observe(el);
    return () => {
      io.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [engine, post, url]);

  return (
    <div className="clip" ref={ref}>
      {url ? (
        <video src={url} playsInline muted loop autoPlay onClick={(e) => (e.currentTarget.muted = !e.currentTarget.muted)} />
      ) : (
        <div className="clip-placeholder">{error ? "読み込めません" : post.content ? "…" : "🔒"}</div>
      )}
      <div className="clip-meta">
        <span>{post.authorName ?? "?"}</span>
        <span>{post.pending ? "送信待ち" : formatTime(post.ts)}</span>
      </div>
    </div>
  );
}
