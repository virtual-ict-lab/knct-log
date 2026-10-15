import { useEffect, useRef, useState } from "react";
import { Screen } from "./Layout.tsx";
import { go, useEngine, useLive } from "./hooks.ts";

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

/** 3 秒固定・撮り直しなし。撮り終えたらそのまま暗号化して送る。 */
export function Capture({ preselect }: { preselect: string | null }) {
  const engine = useEngine();
  const groups = useLive(async (e) => {
    const gs = (await e.groups()).filter((g) => g.isMember && g.hasKey);
    return Promise.all(gs.map(async (g) => ({ ...g, posted: await e.postedThisHour(g.group) })));
  });
  const [targets, setTargets] = useState<Set<string> | null>(null);
  const [facing, setFacing] = useState<"user" | "environment">("environment");
  const [phase, setPhase] = useState<"preview" | "recording" | "sending" | "done">("preview");
  const [remaining, setRemaining] = useState(CLIP_MS);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
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
        video: { facingMode: facing, width: { ideal: 720 }, height: { ideal: 1280 }, frameRate: { ideal: 30 } },
        audio: true,
      })
      .then((stream) => {
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch((e) => setError(`カメラを使えません: ${(e as Error).message}`));
    return () => {
      cancelled = true;
    };
  }, [facing, phase]);

  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  async function record() {
    const stream = streamRef.current;
    const mime = pickMime();
    if (!stream || mime === null || !targets?.size) return;
    setPhase("recording");
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const takenAt = Date.now();
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.start();
    const started = performance.now();
    const timer = setInterval(() => setRemaining(Math.max(0, CLIP_MS - (performance.now() - started))), 100);
    await new Promise((r) => setTimeout(r, CLIP_MS));
    rec.stop();
    await done;
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    setPhase("sending");
    try {
      const blob = new Blob(chunks, { type: rec.mimeType || mime || "video/webm" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await engine.post([...targets], bytes, blob.type, CLIP_MS, takenAt);
      setPhase("done");
      setTimeout(() => go(targets.size === 1 ? `/g/${[...targets][0]}` : "/"), 600);
    } catch (e) {
      setError(`送れませんでした: ${(e as Error).message}`);
      setPhase("preview");
    }
  }

  const noTarget = !targets || targets.size === 0;
  return (
    <Screen title="撮影" back={preselect ? `/g/${preselect}` : "/"}>
      <div className="camera">
        <video ref={videoRef} autoPlay playsInline muted className={facing === "user" ? "mirror" : ""} />
        {phase === "recording" && <div className="countdown">{Math.ceil(remaining / 1000)}</div>}
        {phase === "sending" && <div className="countdown small">暗号化して送信中…</div>}
        {phase === "done" && <div className="countdown small">送りました</div>}
      </div>
      {error && <p className="error">{error}</p>}
      {groups && groups.length > 1 && phase === "preview" && (
        <fieldset className="targets">
          <legend>送り先</legend>
          {groups.map((g) => (
            <label key={g.group} className={g.posted ? "disabled" : ""}>
              <input
                type="checkbox"
                disabled={g.posted}
                checked={targets?.has(g.group) ?? false}
                onChange={(e) => {
                  const next = new Set(targets);
                  if (e.target.checked) next.add(g.group);
                  else next.delete(g.group);
                  setTargets(next);
                }}
              />
              {g.name ?? "…"}
              {g.posted && <span className="hint">（この1時間は撮影済み）</span>}
            </label>
          ))}
        </fieldset>
      )}
      <div className="capture-controls">
        <button
          className="icon-btn"
          aria-label="カメラ切り替え"
          disabled={phase !== "preview"}
          onClick={() => setFacing(facing === "user" ? "environment" : "user")}
        >
          ⟲
        </button>
        <button className="shutter" aria-label="3秒撮影" disabled={phase !== "preview" || noTarget} onClick={record} />
        <span className="icon-btn" />
      </div>
      <p className="hint center">{noTarget ? "この1時間はもう撮りました。" : "ボタンを押すと3秒撮って、そのまま送ります（撮り直しはできません）。"}</p>
    </Screen>
  );
}
