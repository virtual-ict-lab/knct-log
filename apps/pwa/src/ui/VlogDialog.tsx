import { useState } from "react";
import { Check, Film, Play, Share2, Square, X } from "lucide-react";
import type { PostView } from "../lib/engine.ts";
import { Avatar, ErrorNote, IconButton, Sheet } from "./common.tsx";
import { formatDay, formatTime, useEngine } from "./hooks.ts";
import { TextOverlay } from "./GroupPage.tsx";

function canMakeVlog() {
  return typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined" && typeof OffscreenCanvas !== "undefined";
}

/** 「まとめる」：選んだクリップを端末上で 1 本の動画にする。サーバーには送らない。 */
export function VlogDialog({ posts, onClose }: { posts: PostView[]; onClose: () => void }) {
  const engine = useEngine();
  const readable = posts.filter((p) => p.content).sort((a, b) => a.ts - b.ts);
  const [selected, setSelected] = useState(() => new Set(readable.map((p) => p.id)));
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<{ url: string; file: File } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playIndex, setPlayIndex] = useState<number | null>(null);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const chosen = readable.filter((p) => selected.has(p.id));
  const title = `knct-log ${formatDay(readable[0]?.ts ?? Date.now())}`;

  async function build() {
    setError(null);
    setProgress(0);
    try {
      const clips = [];
      for (const p of chosen) clips.push({ video: await engine.video(p), text: p.content!.text });
      // mediabunny は大きいので、まとめるときだけ読み込む
      const { makeVlog } = await import("../lib/vlog.ts");
      const vlog = await makeVlog(clips, (d, t) => setProgress(d / t));
      const file = new File([vlog], `${title.replace(/\s+/g, "_")}.mp4`, { type: "video/mp4" });
      setResult({ url: URL.createObjectURL(vlog), file });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  }

  // WebCodecs がない環境では連続再生だけ
  async function playAt(i: number) {
    if (playUrl) URL.revokeObjectURL(playUrl);
    if (i >= chosen.length) {
      setPlayIndex(null);
      setPlayUrl(null);
      return;
    }
    setPlayIndex(i);
    setPlayUrl(URL.createObjectURL(await engine.video(chosen[i]!)));
  }

  async function share() {
    if (!result) return;
    if (navigator.canShare?.({ files: [result.file] })) {
      await navigator.share({ files: [result.file], title }).catch(() => undefined);
    } else {
      const a = document.createElement("a");
      a.href = result.url;
      a.download = result.file.name;
      a.click();
    }
  }

  function close() {
    if (result) URL.revokeObjectURL(result.url);
    if (playUrl) URL.revokeObjectURL(playUrl);
    onClose();
  }

  return (
    <Sheet onClose={progress === null ? close : () => undefined}>
      {result ? (
        <>
          <video className="vlog" src={result.url} controls playsInline autoPlay />
          <div className="row center">
            <IconButton icon={X} label="閉じる" variant="soft" onClick={close} />
            <IconButton icon={Share2} label="保存・共有" variant="primary" onClick={share} />
          </div>
        </>
      ) : playIndex !== null && playUrl ? (
        <>
          <div className="vlog-play">
            <video className="vlog" src={playUrl} autoPlay playsInline onEnded={() => playAt(playIndex + 1)} />
            <TextOverlay text={chosen[playIndex]?.content?.text} />
          </div>
          <div className="row center">
            <IconButton icon={Square} label="停止" variant="soft" onClick={() => playAt(chosen.length)} />
          </div>
        </>
      ) : (
        <>
          <div className="pick-grid">
            {readable.map((p) => {
              const on = selected.has(p.id);
              return (
                <button
                  key={p.id}
                  className={`pick ${on ? "on" : ""}`}
                  aria-pressed={on}
                  disabled={progress !== null}
                  onClick={() => {
                    const next = new Set(selected);
                    if (on) next.delete(p.id);
                    else next.add(p.id);
                    setSelected(next);
                  }}
                >
                  <Avatar id={p.author} name={p.authorName} size={28} />
                  <span>{formatTime(p.ts)}</span>
                  {on && <Check size={16} className="pick-check" />}
                </button>
              );
            })}
          </div>
          {progress !== null && (
            <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)}>
              <span style={{ width: `${Math.max(4, progress * 100)}%` }} />
            </div>
          )}
          <ErrorNote error={error} />
          <div className="row center">
            <IconButton icon={X} label="やめる" variant="soft" disabled={progress !== null} onClick={close} />
            {canMakeVlog() ? (
              <IconButton icon={Film} label="1本の動画にする" variant="primary" busy={progress !== null} disabled={chosen.length === 0} onClick={build} />
            ) : (
              <IconButton icon={Play} label="続けて再生" variant="primary" disabled={chosen.length === 0} onClick={() => playAt(0)} />
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
