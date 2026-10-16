import { useLayoutEffect, useMemo, useRef } from "react";
import { Hourglass, Lock } from "lucide-react";
import type { PostView } from "../lib/engine.ts";
import { buildTimeline } from "../lib/timeline.ts";
import { Avatar, Spinner } from "./common.tsx";
import { formatDay, formatTime } from "./hooks.ts";
import { TextOverlay, useClipUrl } from "./GroupPage.tsx";
import "./group.css";

type Member = { pk: string; isMe: boolean };

/** トーク風の表示。古い順に下へ積む */
export function TalkView({ posts, members, onOpen }: { posts: PostView[]; members: Member[]; onOpen: (id: string) => void }) {
  const me = members.find((m) => m.isMe)?.pk;
  const items = useMemo(() => buildTimeline(posts), [posts]);
  const scrolled = useRef(false);

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
  return (
    <div className={`msg ${mine ? "mine" : ""}`}>
      {!mine && <Avatar id={post.author} name={post.authorName} size={30} />}
      <div className="msg-body">
        {!mine && <span className="msg-name">{post.authorName ?? "?"}</span>}
        <div className="msg-row">
          <div className="clip" ref={ref} onClick={onOpen} role="button" aria-label={`${post.authorName ?? ""} ${formatTime(post.ts)}`}>
            {url ? <video src={url} playsInline muted loop autoPlay /> : <div className="clip-placeholder">{failed || !post.content ? <Lock size={22} /> : <Spinner size={22} />}</div>}
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

/** 返信先の動画の小さなサムネイル */
function QuoteThumb({ post }: { post: PostView }) {
  const { url, failed, ref } = useClipUrl(post);
  return (
    <span className="quote-thumb" ref={ref}>
      {url ? <video src={url} playsInline muted preload="metadata" /> : failed || !post.content ? <Lock size={12} /> : null}
    </span>
  );
}
