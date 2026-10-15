import { useEffect, useState } from "react";
import type { Endpoint } from "../lib/db.ts";
import { currentSubscription, disablePush, enablePush, needsHomeScreen, pushSupported } from "../lib/push.ts";
import { Screen } from "./Layout.tsx";
import { shortKey, useEngine, useLive } from "./hooks.ts";

export function AppSettings() {
  const engine = useEngine();
  const endpoints = useLive((e) => e.endpoints());
  const [name, setName] = useState(engine.device?.name ?? "");
  const [draft, setDraft] = useState<Endpoint[] | null>(null);
  const [push, setPush] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (endpoints && !draft) setDraft(endpoints);
  }, [endpoints, draft]);
  useEffect(() => {
    void currentSubscription().then((s) => setPush(!!s));
  }, []);

  const run = (f: () => Promise<unknown>, ok?: string) => async () => {
    setMsg(null);
    try {
      await f();
      if (ok) setMsg(ok);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <Screen title="設定" back="/">
      {msg && <div className="banner">{msg}</div>}
      <section className="card stack">
        <h2>プロフィール</h2>
        <label className="field">
          <span>表示名</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} />
        </label>
        <button className="btn" disabled={!name.trim()} onClick={run(() => engine.rename(name.trim()).then(() => engine.sync()), "保存しました")}>
          保存
        </button>
        <p className="hint">端末の鍵: {engine.me && shortKey(engine.me)}</p>
      </section>

      <section className="card stack">
        <h2>通知</h2>
        {!pushSupported() ? (
          <p className="hint">この環境では通知を使えません。</p>
        ) : needsHomeScreen() ? (
          <p className="hint">iPhone では、共有メニューの「ホーム画面に追加」から開くと通知を使えます。</p>
        ) : (
          <button
            className="btn"
            onClick={run(async () => {
              if (push) await disablePush(engine);
              else await enablePush(engine);
              setPush(!push);
            })}
          >
            {push ? "通知をオフにする" : "毎時の撮影通知をオンにする"}
          </button>
        )}
      </section>

      <section className="card stack">
        <h2>サーバー</h2>
        <p className="hint">
          上から順につながるか確かめ、最初に応答したサーバーを使います。学内サーバーを上に置くと、学内では学内サーバー、学外では Cloudflare につながります。
        </p>
        <p>
          接続中: <strong>{engine.conn ? `${engine.conn.endpoint.label}（${engine.conn.serverId}）` : "なし"}</strong>
        </p>
        {draft?.map((ep, i) => (
          <div key={i} className="endpoint">
            <input value={ep.label} placeholder="名前" onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, label: e.target.value } : d)))} />
            <input value={ep.url} placeholder="https://…" onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, url: e.target.value } : d)))} />
            <button className="icon-btn" aria-label="上へ" disabled={i === 0} onClick={() => setDraft(swap(draft, i, i - 1))}>
              ↑
            </button>
            <button className="icon-btn" aria-label="削除" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
        <div className="row">
          <button className="btn small" onClick={() => setDraft([...(draft ?? []), { label: "", url: "" }])}>
            ＋ 追加
          </button>
          <button
            className="btn small primary"
            onClick={run(async () => {
              await engine.setEndpoints((draft ?? []).filter((d) => d.url.trim()).map((d) => ({ label: d.label.trim() || d.url, url: d.url.trim() })));
              await engine.connect(true);
              await engine.sync();
            }, "保存しました")}
          >
            保存して再接続
          </button>
        </div>
      </section>
    </Screen>
  );
}

function swap<T>(xs: T[], i: number, j: number) {
  const a = [...xs];
  [a[i], a[j]] = [a[j]!, a[i]!];
  return a;
}
