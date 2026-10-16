import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { renderSVG } from "uqr";
import { CircleAlert, LoaderCircle } from "lucide-react";

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

/** 名前の頭文字と、ID から決まる色の丸 */
export function Avatar({ id, name, size = 32 }: { id: string; name: string | null; size?: number }) {
  return (
    <span className="avatar" style={{ "--h": hue(id), width: size, height: size, fontSize: size * 0.45 } as React.CSSProperties} aria-hidden>
      {[...(name ?? "?")][0]}
    </span>
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
