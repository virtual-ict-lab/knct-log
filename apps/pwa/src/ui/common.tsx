import { type ComponentType, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { renderSVG } from "uqr";
import { Camera, Check, CircleAlert, LoaderCircle, Trash2, X, ZoomIn } from "lucide-react";
import { isIcon } from "@knct-log/core";
import { type Crop, cropRect, drawCrop, encodeIcon, loadImage } from "../lib/icon.ts";
import { EngineContext } from "./hooks.ts";

type Icon = ComponentType<{ size?: number; strokeWidth?: number }>;

/** 文字の代わりにアイコンだけのボタン。aria-label と title で意味を伝える */
export function IconButton(props: {
  icon: Icon;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "plain" | "primary" | "danger" | "soft";
  size?: number;
  busy?: boolean;
  type?: "button" | "submit";
  /** アイコンの横に出す短い文字。意味が伝わりにくい操作にだけ付ける */
  text?: string;
}) {
  const { icon: I, label, variant = "plain", size = 22 } = props;
  return (
    <button
      type={props.type ?? "button"}
      className={`icon-btn ${variant}${props.text ? " with-text" : ""}`}
      aria-label={label}
      title={label}
      disabled={props.disabled || props.busy}
      onClick={props.onClick}
    >
      {props.busy ? <LoaderCircle size={size} className="spin" /> : <I size={size} />}
      {props.text && <span>{props.text}</span>}
    </button>
  );
}

function hue(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** アイコン画像があればそれを、なければ名前の頭文字と ID から決まる色の丸 */
export function Avatar({ id, name, size = 32, icon }: { id: string; name: string | null; size?: number; icon?: string }) {
  const engine = useContext(EngineContext);
  const src = icon ?? engine?.icons.get(id);
  return (
    <span className="avatar" style={{ "--h": hue(id), width: size, height: size, fontSize: size * 0.45 } as React.CSSProperties} aria-hidden>
      {src && isIcon(src) ? <img src={src} alt="" width={size} height={size} draggable={false} /> : [...(name ?? "?")][0]}
    </span>
  );
}

/** アバターを押すと写真を選び、正方形に切り出してアイコンにする */
export function IconPicker(props: {
  id: string;
  name: string | null;
  icon?: string;
  size?: number;
  label: string;
  onSave: (icon: string | null) => Promise<unknown>;
}) {
  const { size = 44 } = props;
  const [img, setImg] = useState<ImageBitmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      setImg(await loadImage(file));
    } catch {
      setError("この画像は読み込めません");
    }
  }
  return (
    <>
      <button type="button" className="icon-pick" aria-label={props.label} title={props.label} onClick={() => input.current?.click()}>
        <Avatar id={props.id} name={props.name} size={size} icon={props.icon} />
        <span className="icon-pick-badge">
          <Camera size={12} />
        </span>
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {error && <span className="small" role="alert">{error}</span>}
      {img && (
        <IconCropper
          img={img}
          onClose={() => setImg(null)}
          onSave={async (icon) => {
            await props.onSave(icon);
            setImg(null);
          }}
          onRemove={props.icon ? async () => {
            await props.onSave(null);
            setImg(null);
          } : undefined}
        />
      )}
    </>
  );
}

const CROP_VIEW = 240;

function IconCropper(props: {
  img: ImageBitmap;
  onClose: () => void;
  onSave: (icon: string) => Promise<unknown>;
  onRemove?: () => Promise<unknown>;
}) {
  const { img } = props;
  const [crop, setCrop] = useState<Crop>({ zoom: 1, x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.height = Math.round(CROP_VIEW * ratio);
    c.getContext("2d")!.drawImage(drawCrop(img, crop, c.width), 0, 0);
  }, [img, crop]);

  // 指を動かした分だけ、写真が付いてくるように x / y を変える
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { side } = cropRect(img.width, img.height, crop);
    const perPx = side / CROP_VIEW; // 画面 1px あたりの元画像のピクセル
    const axis = (start: number, dpx: number, extent: number) =>
      extent - side > 0 ? Math.max(-1, Math.min(1, start - (dpx * perPx) / ((extent - side) / 2))) : 0;
    setCrop((c) => ({ ...c, x: axis(d.x, e.clientX - d.px, img.width), y: axis(d.y, e.clientY - d.py, img.height) }));
  };

  async function run(f: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={props.onClose}>
      <div className="cropper">
        <canvas
          ref={canvas}
          className="crop-canvas"
          style={{ width: CROP_VIEW, height: CROP_VIEW }}
          aria-label="アイコンの範囲"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { px: e.clientX, py: e.clientY, x: crop.x, y: crop.y };
          }}
          onPointerMove={move}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        />
        <div className="row crop-zoom">
          <ZoomIn size={20} className="muted" />
          <input
            type="range"
            min={1}
            max={4}
            step={0.05}
            value={crop.zoom}
            aria-label="拡大"
            onChange={(e) => setCrop({ ...crop, zoom: Number(e.target.value) })}
          />
        </div>
        {error && <span className="small" role="alert">{error}</span>}
        <div className="row center">
          {props.onRemove && (
            <IconButton icon={Trash2} label="アイコンを外す" variant="danger" busy={busy} onClick={() => void run(props.onRemove!)} />
          )}
          <IconButton icon={X} label="キャンセル" onClick={props.onClose} />
          <IconButton icon={Check} label="保存" variant="primary" busy={busy} onClick={() => void run(async () => props.onSave(await encodeIcon(img, crop)))} />
        </div>
      </div>
    </Sheet>
  );
}

export function Sheet({ onClose, children, dark }: { onClose: () => void; children: ReactNode; dark?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className={`sheet ${dark ? "dark" : ""}`} role="dialog" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function Qr({ text }: { text: string }) {
  return <div className="qr" role="img" aria-label="QR" dangerouslySetInnerHTML={{ __html: renderSVG(text, { pixelSize: 6 }) }} />;
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="note error" role="alert">
      <CircleAlert size={18} />
      <span>{error}</span>
    </div>
  );
}

export function Spinner({ size = 28 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-label="読み込み中" />;
}

/** 非同期の操作。実行中フラグとエラーを持つ */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run =
    (name: string, f: () => Promise<unknown>) =>
    async () => {
      setBusy(name);
      setError(null);
      try {
        await f();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    };
  return { busy, error, setError, run };
}

/** ボタンを押したあと少しだけチェックを出す */
export function useFlash(ms = 1500): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return [on, () => setOn(true)];
}

export const QUICK_EMOJIS = ["❤️", "😂", "😮", "🔥", "👍"];
