import { useEffect, useRef, useState } from "react";
import { Check, Send, SwitchCamera, X } from "lucide-react";
import { MAX_POST_TEXT } from "@knct-log/core";
import { Avatar, ErrorNote, IconButton, Spinner } from "./common.tsx";
import { TextOverlay } from "./GroupPage.tsx";
import { go, useEngine, useLive } from "./hooks.ts";
import "./capture.css";

const CLIP_MS = 3000;
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm",
];

function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

type Clip = { bytes: Uint8Array<ArrayBuffer>; mime: string; url: string; takenAt: number; size: { w: number; h: number } };

/** 撮る動画の大きさ。端末の向きによらず横動画にする */
const OUT_W = 1280;
const OUT_H = 720;

/** カメラの映像の中央を 16:9 に切り抜いた映像に、カメラの音声を付ける（プレビューの object-fit: cover と同じ範囲） */
function landscapeStream(video: HTMLVideoElement, source: MediaStream) {
  const canvas = document.createElement("canvas");
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext("2d")!;
  let raf = 0;
  const draw = () => {
    const { videoWidth: vw, videoHeight: vh } = video;
    if (vw && vh) {
      const scale = Math.max(OUT_W / vw, OUT_H / vh);
      const w = OUT_W / scale;
      const h = OUT_H / scale;
      ctx.drawImage(video, (vw - w) / 2, (vh - h) / 2, w, h, 0, 0, OUT_W, OUT_H);
    }
    raf = requestAnimationFrame(draw);
  };
  draw();
  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...source.getAudioTracks()]);
  return {
    stream,
    stop() {
      cancelAnimationFrame(raf);
      stream.getVideoTracks().forEach((t) => t.stop());
    },
  };
}

/**
 * 3 秒固定。撮った直後に動画の中央へ文字入力（フォーカス済み）を出す。
 * 送信前のキャンセルは破棄してカメラに戻る（何度でも撮り直せる）。
 */
export function Capture({ preselect }: { preselect: string | null }) {
  const engine = useEngine();
  const back = preselect ? `/g/${preselect}` : "/";
  const groups = useLive(async (e) => {
    const gs = (await e.groups()).filter((g) => g.isMember && g.hasKey);
    return Promise.all(gs.map(async (g) => ({ ...g, posted: await e.postedThisHour(g.group) })));
  });
  const [targets, setTargets] = useState<Set<string> | null>(null);
  const [facing, setFacing] = useState<"user" | "environment">("environment");
  const [phase, setPhase] = useState<"preview" | "recording" | "review" | "sending" | "done">("preview");
  const [progress, setProgress] = useState(0);
  const [clip, setClip] = useState<Clip | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!groups || targets) return;
    const open = groups.filter((g) => !g.posted).map((g) => g.group);
    setTargets(new Set(preselect && open.includes(preselect) ? [preselect] : open));
  }, [groups, targets, preselect]);

  useEffect(() => {
    if (phase !== "preview") return;
    let cancelled = false;
    navigator.mediaDevices
      ?.getUserMedia({
        video: {
          facingMode: facing,
          // 縦に持つと縦長で届くので、切り抜いても足りるように大きめに頼む
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: true,
      })
      .then((stream) => {
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch((e) => setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [facing, phase]);

  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);
  // スマホでは全画面にして、横にしたときにブラウザのバーを出さずに画面いっぱいで撮れるようにする
  // （撮影ボタンを押した直後なので許可される。iPhone のように使えない端末ではそのまま）
  useEffect(() => {
    const el = document.documentElement;
    if (!matchMedia("(pointer: coarse)").matches || document.fullscreenElement || !el.requestFullscreen) return;
    let entered = false;
    el.requestFullscreen({ navigationUI: "hide" }).then(() => (entered = true), () => {});
    return () => {
      if (entered && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  useEffect(() => () => void (clip && URL.revokeObjectURL(clip.url)), [clip]);

  async function record() {
    const stream = streamRef.current;
    const video = videoRef.current;
    const mime = pickMime();
    if (!stream || !video || mime === null || !targets?.size) return;
    setPhase("recording");
    const out = landscapeStream(video, stream);
    const rec = new MediaRecorder(out.stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const takenAt = Date.now();
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.start();
    const started = performance.now();
    const timer = setInterval(() => setProgress(Math.min(1, (performance.now() - started) / CLIP_MS)), 50);
    await new Promise((r) => setTimeout(r, CLIP_MS));
    rec.stop();
    await done;
    clearInterval(timer);
    out.stop();
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: rec.mimeType || mime || "video/webm" });
    setClip({ bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, url: URL.createObjectURL(blob), takenAt, size: { w: OUT_W, h: OUT_H } });
    setPhase("review");
  }

  function retake() {
    setClip(null);
    setText("");
    setError(null);
    setProgress(0);
    setPhase("preview");
  }

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, [text, phase]);

  async function send() {
    if (!clip || !targets?.size) return;
    setPhase("sending");
    try {
      await engine.post([...targets], clip.bytes, clip.mime, CLIP_MS, clip.takenAt, text, clip.size);
      setPhase("done");
      setTimeout(() => go(back), 600);
    } catch (e) {
      setError((e as Error).message);
      setPhase("review");
    }
  }

  const open = groups?.filter((g) => !g.posted) ?? [];
  const noTarget = !targets || targets.size === 0;
  const showTargets = (groups?.length ?? 0) > 1 && (phase === "preview" || phase === "review");

  return (
    <div className="fullscreen dark capture">
      <div className="viewfinder" onClick={() => phase === "review" && textRef.current?.focus()}>
        {phase === "review" || phase === "sending" || phase === "done" ? (
          <video
            key="clip"
            src={clip?.url}
            autoPlay
            loop
            playsInline
          />
        ) : (
          <video key="live" ref={videoRef} autoPlay playsInline muted className={facing === "user" ? "mirror" : ""} />
        )}
        {phase === "review" ? (
          <textarea
            ref={textRef}
            className="overlay-text editing"
            value={text}
            rows={1}
            onChange={(e) => setText(e.target.value.replace(/\n/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())}
            maxLength={MAX_POST_TEXT}
            autoFocus
            aria-label="文字"
          />
        ) : (
          (phase === "sending" || phase === "done") && <TextOverlay text={text.trim()} />
        )}
        {phase === "sending" && <div className="center-badge"><Spinner size={40} /></div>}
        {phase === "done" && <div className="center-badge"><Check size={48} /></div>}
      </div>

      <div className="top-controls">
        {phase === "preview" && <IconButton icon={X} label="閉じる" variant="soft" onClick={() => go(back)} />}
        {phase === "review" && <IconButton icon={X} label="キャンセル" variant="soft" onClick={retake} />}
        {phase !== "preview" && phase !== "review" && <span />}
        {phase === "preview" && <IconButton icon={SwitchCamera} label="カメラ切り替え" variant="soft" onClick={() => setFacing(facing === "user" ? "environment" : "user")} />}
      </div>

      <div className="bottom-controls">
        <ErrorNote error={error} />
        {showTargets && (
          <div className="targets" role="group" aria-label="送り先">
            {groups!.map((g) => {
              const on = targets?.has(g.group) ?? false;
              return (
                <button
                  key={g.group}
                  className={`target ${on ? "on" : ""}`}
                  disabled={g.posted || (phase !== "preview" && phase !== "review")}
                  aria-pressed={on}
                  title={g.name ?? ""}
                  onClick={() => {
                    const next = new Set(targets);
                    if (on) next.delete(g.group);
                    else next.add(g.group);
                    setTargets(next);
                  }}
                >
                  <Avatar id={g.group} name={g.name} size={36} />
                  {g.posted && <Check size={14} className="target-done" />}
                </button>
              );
            })}
          </div>
        )}
        <div className="shutter-row">
          {phase === "review" ? (
            <button className="send-btn" aria-label="送る" title="送る" disabled={noTarget} onClick={send}>
              <Send size={30} />
            </button>
          ) : (
            <button
              className={`shutter ${phase === "recording" ? "recording" : ""}`}
              style={{ "--p": progress } as React.CSSProperties}
              aria-label="3秒撮影"
              title="3秒撮影"
              disabled={phase !== "preview" || noTarget || open.length === 0}
              onClick={record}
            />
          )}
        </div>
      </div>
    </div>
  );
}
