import { useState } from "react";
import type { PostView } from "../lib/engine.ts";
import { formatDay, formatTime, useEngine } from "./hooks.ts";

function canMakeVlog() {
  return typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined" && typeof OffscreenCanvas !== "undefined";
}

/** 「まとめる」：選んだクリップを端末上で 1 本の動画にする。サーバーには送らない。 */
export function VlogDialog({ posts, onClose }: { posts: PostView[]; onClose: () => void }) {
  const engine = useEngine();
  const readable = posts.filter((p) => p.content).sort((a, b) => a.ts - b.ts);
  const [selected, setSelected] = useState(() => new Set(readable.map((p) => p.id)));
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; file: File } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playIndex, setPlayIndex] = useState<number | null>(null);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const chosen = readable.filter((p) => selected.has(p.id));
  const title = `knct-log ${formatDay(readable[0]?.ts ?? Date.now())}`;

  async function build() {
    setError(null);
    try {
      setProgress("動画を準備中…");
      const clips = [];
      for (const p of chosen) clips.push(await engine.video(p));
      // mediabunny は大きいので、まとめるときだけ読み込む
      const { makeVlog } = await import("../lib/vlog.ts");
      const vlog = await makeVlog(clips, (d, t) => setProgress(`まとめています… ${d}/${t}`));
      const file = new File([vlog], `${title.replace(/\s+/g, "_")}.mp4`, { type: "video/mp4" });
      setResult({ url: URL.createObjectURL(vlog), file });
    } catch (e) {
      setError(`まとめられませんでした: ${(e as Error).message}`);
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
    <div className="dialog-backdrop" onClick={close}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{formatDay(readable[0]?.ts ?? Date.now())}をまとめる</h2>
        {result ? (
          <>
            <video className="vlog" src={result.url} controls playsInline autoPlay />
            <div className="row">
              <button className="btn" onClick={close}>
                閉じる
              </button>
              <button className="btn primary" onClick={share}>
                保存・共有
              </button>
            </div>
          </>
        ) : playIndex !== null && playUrl ? (
          <>
            <video className="vlog" src={playUrl} autoPlay playsInline onEnded={() => playAt(playIndex + 1)} />
            <p className="hint">
              {playIndex + 1} / {chosen.length}
            </p>
            <button className="btn" onClick={() => playAt(chosen.length)}>
              停止
            </button>
          </>
        ) : (
          <>
            <ul className="pick-list">
              {readable.map((p) => (
                <li key={p.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(p.id);
                        else next.delete(p.id);
                        setSelected(next);
                      }}
                    />
                    <span>{formatTime(p.ts)}</span>
                    <span className="hint">{p.authorName ?? "?"}</span>
                  </label>
                </li>
              ))}
            </ul>
            {progress && <p className="hint">{progress}</p>}
            {error && <p className="error">{error}</p>}
            <p className="hint">動画はこの端末の中だけで作られ、サーバーには送られません。</p>
            <div className="row">
              <button className="btn" onClick={close} disabled={!!progress}>
                やめる
              </button>
              {canMakeVlog() ? (
                <button className="btn primary" onClick={build} disabled={!!progress || chosen.length === 0}>
                  1本の動画にする
                </button>
              ) : (
                <button className="btn primary" onClick={() => playAt(0)} disabled={chosen.length === 0}>
                  続けて再生
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
