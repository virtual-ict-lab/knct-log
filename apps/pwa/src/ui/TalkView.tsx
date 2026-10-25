import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Hourglass, Lock } from "lucide-react";
import type { PostView } from "../lib/engine.ts";
import { buildTimeline } from "../lib/timeline.ts";
import { aspectOf } from "../lib/layout.ts";
import { Avatar, Spinner } from "./common.tsx";
import { formatDay, formatTime, useEngine } from "./hooks.ts";
import { TextOverlay, useClipUrl } from "./GroupPage.tsx";
import "./group.css";

type Member = { pk: string; isMe: boolean };

/** トーク風の表示。古い順に下へ積む */
export function TalkView({ posts, members, onOpen }: { posts: PostView[]; members: Member[]; onOpen: (id: string) => void }) {
  const me = members.find((m) => m.isMe)?.pk;
  const items = useMemo(() => buildTimeline(posts), [posts]);
  const scrolled = useRef(false);
  const engine = useEngine();
  const group = posts[0]?.group;

  // 初めて開いたグループでは、それまでの投稿を見たことにする（Engine.markSeen）
  useEffect(() => {
    if (group) engine.markSeen(group, []).catch(console.error);
  }, [engine, group]);

  // 開いたとき最下部へ。日付ジャンプ後や新着では動かさない
  useLayoutEffect(() => {
    if (scrolled.current || !items.length) return;
    scrolled.current = true;
    window.scrollTo(0, document.documentElement.scrollHeight);
  }, [items.length]);

  return (
    <div className="talk">
      {items.map((it) => {
        if (it.type === "day")
          return (
            <div key={`d${it.key}`} className="talk-day" data-day={it.key}>
              {formatDay(it.ts)}
            </div>
          );
        if (it.type === "clip") return <ClipBubble key={it.post.id} post={it.post} mine={it.post.author === me} onOpen={() => onOpen(it.post.id)} />;
        return (
          <div key={it.id} className={`msg ${it.author === me ? "mine" : ""}`}>
            {it.author !== me && <Avatar id={it.author} name={it.authorName} size={30} />}
            <div className="msg-body">
              {it.author !== me && <span className="msg-name">{it.authorName ?? "?"}</span>}
              <button className="quote" onClick={() => onOpen(it.to.id)} aria-label={`${it.to.authorName ?? ""} ${formatTime(it.to.ts)}`}>
                <QuoteThumb post={it.to} />
              </button>
              <div className="msg-row">
                <div className="bubble">{it.text}</div>
                <span className="msg-time">{formatTime(it.ts)}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ClipBubble({ post, mine, onOpen }: { post: PostView; mine: boolean; onOpen: () => void }) {
  const { url, failed, ref } = useClipUrl(post);
  const [aspect, setAspect] = useState(() => aspectOf(post));
  const seenRef = useSeenOnView(post);
  return (
    <div className={`msg ${mine ? "mine" : ""}`} ref={seenRef}>
      {!mine && <Avatar id={post.author} name={post.authorName} size={30} />}
      <div className="msg-body">
        {!mine && <span className="msg-name">{post.authorName ?? "?"}</span>}
        <div className="msg-row">
          <div
            className={`clip ${aspect > 1 ? "landscape" : ""}`}
            ref={ref}
            style={{ aspectRatio: aspect }}
            onClick={onOpen}
            role="button"
            aria-label={`${post.authorName ?? ""} ${formatTime(post.ts)}`}
          >
            {url ? (
              <video src={url} playsInline muted loop autoPlay onLoadedMetadata={(e) => e.currentTarget.videoHeight && setAspect(e.currentTarget.videoWidth / e.currentTarget.videoHeight)} />
            ) : (
              <div className="clip-placeholder">{failed || !post.content ? <Lock size={22} /> : <Spinner size={22} />}</div>
            )}
            <TextOverlay text={post.content?.text} />
          </div>
          <span className="msg-time">{post.pending ? <Hourglass size={12} /> : formatTime(post.ts)}</span>
        </div>
        {post.reactions.length > 0 && (
          <div className="talk-reactions">
            {post.reactions.map((r) => (
              <span key={r.emoji} className={r.mine ? "mine" : ""}>
                {r.emoji}
                {r.count > 1 && <small>{r.count}</small>}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 半分以上が画面に出たら、その投稿を見たことにする */
function useSeenOnView(post: PostView) {
  const engine = useEngine();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!post.unread || !el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        engine.markSeen(post.group, [post]).catch(console.error);
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
    // 投稿 ID と未読かどうかだけを見る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, post.id, post.unread]);
  return ref;
}

/** 返信先の動画の小さなサムネイル */
function QuoteThumb({ post }: { post: PostView }) {
  const { url, failed, ref } = useClipUrl(post);
  return (
    <span className="quote-thumb" ref={ref}>
      {url ? <video src={url} playsInline muted preload="metadata" /> : failed || !post.content ? <Lock size={12} /> : null}
    </span>
  );
}
