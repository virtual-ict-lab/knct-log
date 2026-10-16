import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, CalendarDays, Check, Copy, Film, Hourglass, KeyRound, LayoutGrid, Lock, MessageCircle, Plus, Send, Settings, Share2, UserPlus, Volume2, VolumeX } from "lucide-react";
import { MAX_REPLY_TEXT } from "@knct-log/core";
import type { PostView } from "../lib/engine.ts";
import { Screen } from "./Layout.tsx";
import { VlogDialog } from "./VlogDialog.tsx";
import { CalendarSheet } from "./CalendarSheet.tsx";
import { TalkView } from "./TalkView.tsx";
import { Avatar, ErrorNote, IconButton, QUICK_EMOJIS, Qr, Sheet, Spinner, useAction, useFlash } from "./common.tsx";
import { dayKey, formatDay, formatTime, go, useEngine, useLive } from "./hooks.ts";

const VIEW_KEY = "knct-log:group-view";
function loadMode(): "grid" | "talk" {
  try {
    return localStorage.getItem(VIEW_KEY) === "talk" ? "talk" : "grid";
  } catch {
    return "grid";
  }
}

export function GroupPage({ group }: { group: string }) {
  const view = useLive((e) => e.groupView(group), [group]);
  const posts = useLive((e) => e.posts(group), [group]);
  const posted = useLive((e) => e.postedThisHour(group), [group]);
  const [vlogDay, setVlogDay] = useState<PostView[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [mode, setMode] = useState(loadMode);
  const [calendar, setCalendar] = useState(false);
  const [jump, setJump] = useState<string | null>(null);
  const switchMode = () => {
    const next = mode === "grid" ? "talk" : "grid";
    setMode(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* 保存できなくても動く */
    }
  };
  // カレンダーで選んだ日へスクロール
  useEffect(() => {
    if (!jump) return;
    document.querySelector(`[data-day="${jump}"]`)?.scrollIntoView({ block: "start" });
    setJump(null);
  }, [jump, mode, posts]);

  const days = useMemo(() => {
    const m = new Map<string, PostView[]>();
    for (const p of posts ?? []) (m.get(dayKey(p.ts)) ?? m.set(dayKey(p.ts), []).get(dayKey(p.ts))!).push(p);
    return [...m.values()];
  }, [posts]);
  const open = posts?.find((p) => p.id === openId) ?? null;

  if (!view) return <Screen title="" back="/">{null}</Screen>;
  const ready = view.isMember && view.hasKey;

  return (
    <Screen
      title={
        <span className="bar-title">
          <Avatar id={group} name={view.name} size={28} />
          <span>{view.name ?? "…"}</span>
        </span>
      }
      back="/"
      actions={
        view.isMember && (
          <>
            <IconButton icon={CalendarDays} label="カレンダー" onClick={() => setCalendar(true)} />
            <IconButton icon={mode === "grid" ? MessageCircle : LayoutGrid} label={mode === "grid" ? "トーク表示" : "一覧表示"} onClick={switchMode} />
            {ready && view.members.length < 12 && <IconButton icon={UserPlus} label="招待" onClick={() => setInviting(true)} />}
            <IconButton icon={Settings} label="グループ設定" onClick={() => go(`/g/${group}/settings`)} />
          </>
        )
      }
    >
      {view.joining ? (
        <Waiting icon={<Hourglass size={36} />} label="参加待ち" />
      ) : !view.isMember ? (
        <Waiting icon={<Lock size={36} />} label="メンバーではありません" />
      ) : !view.hasKey ? (
        <Waiting icon={<KeyRound size={36} />} label="鍵の受け取り待ち" />
      ) : null}

      {mode === "talk" && posts && <TalkView posts={posts} members={view.members} onOpen={setOpenId} />}
      {mode === "grid" && days.map((day) => (
        <section key={dayKey(day[0]!.ts)} className="day" data-day={dayKey(day[0]!.ts)}>
          <div className="day-head">
            <h2>{formatDay(day[0]!.ts)}</h2>
            <IconButton icon={Film} label="まとめる" disabled={!day.some((p) => p.content)} onClick={() => setVlogDay(day)} />
          </div>
          <div className="grid">
            {day.map((p) => (
              <ClipCard key={p.id} post={p} onOpen={() => setOpenId(p.id)} />
            ))}
          </div>
        </section>
      ))}

      {ready && (
        <button className={`fab ${posted ? "done" : ""}`} aria-label={posted ? "この1時間は撮影済み" : "撮影"} title={posted ? "この1時間は撮影済み" : "撮影"} disabled={!!posted} onClick={() => go(`/capture?g=${group}`)}>
          {posted ? <Check size={28} /> : <Camera size={28} />}
        </button>
      )}
      {vlogDay && <VlogDialog posts={vlogDay} onClose={() => setVlogDay(null)} />}
      {open && <ClipSheet post={open} onClose={() => setOpenId(null)} />}
      {calendar && posts && (
        <CalendarSheet
          posts={posts}
          onClose={() => setCalendar(false)}
          onPick={(k) => {
            setCalendar(false);
            setJump(k);
          }}
        />
      )}
      {inviting && <InviteSheet group={group} name={view.name} onClose={() => setInviting(false)} />}
    </Screen>
  );
}

function Waiting({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="waiting" title={label} aria-label={label}>
      {icon}
    </div>
  );
}

/** 復号した動画の URL。画面に入ってから取得する */
export function useClipUrl(post: PostView, eager = false) {
  const engine = useEngine();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!post.content) return;
    let objectUrl: string | null = null;
    let alive = true;
    const load = () =>
      engine.video(post).then(
        (b) => alive && setUrl((objectUrl = URL.createObjectURL(b))),
        () => alive && setFailed(true),
      );
    let io: IntersectionObserver | null = null;
    if (eager || !ref.current) void load();
    else {
      io = new IntersectionObserver(([entry]) => {
        if (!entry?.isIntersecting) return;
        io?.disconnect();
        void load();
      });
      io.observe(ref.current);
    }
    return () => {
      alive = false;
      io?.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // 投稿 ID が同じなら動画も同じ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, post.id, !!post.content, eager]);
  return { url, failed, ref };
}

export function TextOverlay({ text }: { text?: string }) {
  if (!text) return null;
  return <div className="overlay-text">{text}</div>;
}

function ClipCard({ post, onOpen }: { post: PostView; onOpen: () => void }) {
  const { url, failed, ref } = useClipUrl(post);
  return (
    <div className="clip" ref={ref} onClick={onOpen} role="button" aria-label={`${post.authorName ?? ""} ${formatTime(post.ts)}`}>
      {url ? (
        <video src={url} playsInline muted loop autoPlay />
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

/** 1 本を大きく見る。リアクションと返信 */
function ClipSheet({ post, onClose }: { post: PostView; onClose: () => void }) {
  const engine = useEngine();
  const { url, failed } = useClipUrl(post, true);
  const [muted, setMuted] = useState(false);
  const [reply, setReply] = useState("");
  const [custom, setCustom] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const canAct = !!post.content && !post.pending;

  return (
    <Sheet onClose={onClose} dark>
      <div className="clip-large">
        {url ? (
          <video src={url} playsInline autoPlay loop muted={muted} onClick={() => setMuted(!muted)} />
        ) : (
          <div className="clip-placeholder">{failed ? <Lock size={28} /> : <Spinner />}</div>
        )}
        <TextOverlay text={post.content?.text} />
        <div className="clip-meta">
          <Avatar id={post.author} name={post.authorName} size={26} />
          <span>{post.authorName}</span>
          <span className="muted">{formatTime(post.ts)}</span>
        </div>
        {url && (
          <div className="mute-toggle">
            <IconButton icon={muted ? VolumeX : Volume2} label={muted ? "音を出す" : "消音"} variant="soft" size={18} onClick={() => setMuted(!muted)} />
          </div>
        )}
      </div>

      <div className="reaction-bar">
        {[...new Set([...QUICK_EMOJIS, ...post.reactions.map((r) => r.emoji)])].map((e) => {
          const r = post.reactions.find((x) => x.emoji === e);
          return (
            <button key={e} className={`emoji ${r?.mine ? "mine" : ""}`} disabled={!canAct || !!busy} onClick={run("react", () => engine.react(post, e))} aria-label={e}>
              {e}
              {r && <small>{r.count}</small>}
            </button>
          );
        })}
        {custom === null ? (
          <IconButton icon={Plus} label="ほかの絵文字" size={20} disabled={!canAct} onClick={() => setCustom("")} />
        ) : (
          <form
            className="emoji-input"
            onSubmit={(e) => {
              e.preventDefault();
              const v = [...custom.trim()].slice(0, 2).join("");
              if (v) void run("react", () => engine.react(post, v))();
              setCustom(null);
            }}
          >
            <input value={custom} onChange={(e) => setCustom(e.target.value)} autoFocus maxLength={8} aria-label="絵文字" />
            <IconButton icon={Check} label="付ける" type="submit" size={18} />
          </form>
        )}
      </div>

      <ul className="replies">
        {post.replies.map((r) => (
          <li key={r.id}>
            <Avatar id={r.author} name={r.authorName} size={26} />
            <div>
              <span className="reply-name">{r.authorName ?? "?"}</span>
              <span className="muted">{formatTime(r.ts)}</span>
              <p>{r.text}</p>
            </div>
          </li>
        ))}
      </ul>
      <ErrorNote error={error} />
      <form
        className="reply-form"
        onSubmit={(e) => {
          e.preventDefault();
          const text = reply.trim();
          if (!text) return;
          void run("reply", async () => {
            await engine.reply(post, text);
            setReply("");
          })();
        }}
      >
        <input value={reply} onChange={(e) => setReply(e.target.value)} maxLength={MAX_REPLY_TEXT} placeholder="…" aria-label="返信" disabled={!canAct} />
        <IconButton icon={Send} label="返信する" type="submit" variant="primary" size={20} disabled={!canAct || !reply.trim()} busy={busy === "reply"} />
      </form>
    </Sheet>
  );
}

/** 招待リンクを作り、QR と共有ボタンで渡す */
function InviteSheet({ group, name, onClose }: { group: string; name: string | null; onClose: () => void }) {
  const engine = useEngine();
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, flash] = useFlash();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    engine.createInviteLink(group, location.origin).then(setLink, (e) => setError((e as Error).message));
  }, [engine, group]);

  return (
    <Sheet onClose={onClose}>
      <div className="share-panel">
        {link ? <Qr text={link} /> : error ? <ErrorNote error={error} /> : <Spinner />}
        {link && (
          <div className="row center">
            <IconButton
              icon={copied ? Check : Copy}
              label="コピー"
              variant="soft"
              onClick={() => navigator.clipboard.writeText(link).then(flash)}
            />
            {"share" in navigator && (
              <IconButton
                icon={Share2}
                label="共有"
                variant="primary"
                onClick={() => navigator.share({ title: name ?? "knct-log", url: link }).catch(() => undefined)}
              />
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
