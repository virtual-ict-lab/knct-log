import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { ErrorNote, IconButton } from "./common.tsx";

type Detect = (v: HTMLVideoElement) => Promise<string | null>;

/** BarcodeDetector があれば使い、なければ（iOS など）jsQR で読む */
async function makeDetector(): Promise<Detect> {
  const BD = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(v: CanvasImageSource): Promise<{ rawValue: string }[]> } })
    .BarcodeDetector;
  if (BD) {
    const d = new BD({ formats: ["qr_code"] });
    return async (v) => (await d.detect(v))[0]?.rawValue ?? null;
  }
  const { default: jsQR } = await import("jsqr");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  return async (v) => {
    if (!v.videoWidth) return null;
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    ctx.drawImage(v, 0, 0);
    return jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data ?? null;
  };
}

/** カメラで QR を読む。このアプリのリンク（招待・端末の引き継ぎ）だけを受け付ける */
export function Scanner({ onResult, onClose }: { onResult: (hash: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let alive = true;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!alive) return;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play().catch(() => undefined);
        const detect = await makeDetector();
        let busy = false;
        timer = setInterval(async () => {
          if (busy || !alive) return;
          busy = true;
          try {
            const text = await detect(v);
            const hash = text ? appHash(text) : null;
            if (hash) {
              alive = false;
              onResult(hash);
            }
          } finally {
            busy = false;
          }
        }, 250);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  return (
    <div className="fullscreen dark">
      <video ref={videoRef} playsInline muted className="scanner-video" />
      <div className="scanner-frame" aria-hidden />
      <div className="top-controls">
        <IconButton icon={X} label="閉じる" onClick={onClose} variant="soft" />
      </div>
      <div className="bottom-note">
        <ErrorNote error={error} />
      </div>
    </div>
  );
}

/** knct-log のリンク（…/#/join?… や …/#/link?…）なら、その #/… 部分を返す */
export function appHash(text: string): string | null {
  try {
    const u = new URL(text);
    return /^#\/(join|link)\?/.test(u.hash) ? u.hash.slice(1) : null;
  } catch {
    return null;
  }
}
