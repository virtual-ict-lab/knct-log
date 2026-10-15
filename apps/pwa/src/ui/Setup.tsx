import { useState } from "react";
import { useEngine } from "./hooks.ts";

export function Setup() {
  const engine = useEngine();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await engine.setupDevice(name.trim());
    } catch (err) {
      setError(`この端末では鍵を作れませんでした（${(err as Error).message}）。ブラウザを最新にしてください。`);
      setBusy(false);
    }
  }

  return (
    <div className="screen setup">
      <main>
        <h1 className="logo">knct-log</h1>
        <p className="lead">1時間に1回、3秒だけ。仲間とだけ共有する日常ログ。</p>
        <form onSubmit={submit} className="card stack">
          <label className="field">
            <span>表示名</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} required autoFocus placeholder="例: たくま" />
          </label>
          <p className="hint">
            この端末で暗号鍵を作ります。動画はこの端末で暗号化され、サーバーには中身が見えません。
            鍵はこの端末にだけ保存されるので、端末を変えたらグループに参加し直してください。
          </p>
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy || !name.trim()}>
            はじめる
          </button>
        </form>
      </main>
    </div>
  );
}
