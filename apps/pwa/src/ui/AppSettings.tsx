import { useEffect, useState } from "react";
import { ArrowUp, Bell, BellOff, Check, Clock, KeyRound, LogOut, Plus, QrCode, Server, Smartphone, X } from "lucide-react";
import type { Endpoint } from "../lib/db.ts";
import { PasskeyError, passkeySupported, webPasskey } from "../lib/passkey.ts";
import { currentSubscription, disablePush, enablePush, needsHomeScreen, pushSupported } from "../lib/push.ts";
import { ConnectionDot, Screen } from "./Layout.tsx";
import { Avatar, ErrorNote, IconButton, Qr, Sheet, useAction } from "./common.tsx";
import { go, useEngine, useLive } from "./hooks.ts";

export function AppSettings() {
  const engine = useEngine();
  const endpoints = useLive((e) => e.endpoints());
  const info = useLive((e) => e.accountInfo());
  const [name, setName] = useState(engine.name);
  const [draft, setDraft] = useState<Endpoint[] | null>(null);
  const [push, setPush] = useState<boolean | null>(null);
  const [link, setLink] = useState<{ id: string; url: string; exp: number } | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (endpoints && !draft) setDraft(endpoints);
  }, [endpoints, draft]);
  useEffect(() => {
    void currentSubscription().then((s) => setPush(!!s));
  }, []);

  const passkeyAction = (f: () => Promise<unknown>) => async () => {
    try {
      await f();
    } catch (e) {
      if (e instanceof PasskeyError) {
        if (e.code === "cancelled") return;
        throw new Error(e.code === "no-prf" ? "このパスキーは鍵の保存に対応していません" : "この端末ではパスキーを使えません");
      }
      throw e;
    }
  };

  async function signOut() {
    const warn = info?.passkeys
      ? "この端末からログアウトしますか？"
      : "パスキーがないため、ログアウトするとこのアカウントに戻れなくなります。ログアウトしますか？";
    if (!confirm(warn)) return;
    await engine.signOut();
    go("/");
  }

  return (
    <Screen title="" back="/" actions={<ConnectionDot />}>
      <ErrorNote error={error} />

      <section className="card">
        <div className="field-row">
          <Avatar id={engine.me ?? ""} name={name || engine.name} size={44} />
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} aria-label="表示名" />
          <IconButton
            icon={Check}
            label="保存"
            variant="primary"
            disabled={!name.trim() || name.trim() === engine.name}
            busy={busy === "name"}
            onClick={run("name", () => engine.rename(name.trim()).then(() => engine.sync()))}
          />
        </div>
      </section>

      <section className="card">
        <div className="field-row">
          <KeyRound size={20} className="muted" aria-label="パスキー" />
          <span className="badge-count" title="登録済みのパスキー">{info?.passkeys ?? "…"}</span>
          <span className="spacer" />
          {passkeySupported() && (
            <IconButton icon={Plus} label="パスキーを追加" busy={busy === "passkey"} onClick={run("passkey", passkeyAction(() => engine.addPasskey(webPasskey)))} />
          )}
        </div>
        <div className="field-row">
          <Smartphone size={20} className="muted" aria-label="ほかの端末" />
          <span className="spacer" />
          <IconButton
            icon={QrCode}
            label="ほかの端末で使う（QR）"
            busy={busy === "link"}
            onClick={run("link", async () => setLink(await engine.createDeviceLink(location.origin)))}
          />
        </div>
      </section>

      <section className="card">
        <div className="field-row">
          {push ? <Bell size={20} className="muted" /> : <BellOff size={20} className="muted" />}
          <span className="spacer" />
          {!pushSupported() ? (
            <span className="muted small">—</span>
          ) : needsHomeScreen() ? (
            <span className="muted small">ホーム画面に追加すると使えます</span>
          ) : (
            <label className="switch" title="毎時の撮影通知">
              <input
                type="checkbox"
                checked={!!push}
                aria-label="毎時の撮影通知"
                onChange={run("push", async () => {
                  if (push) await disablePush(engine);
                  else await enablePush(engine);
                  setPush(!push);
                })}
              />
              <span />
            </label>
          )}
        </div>
      </section>

      <details className="card">
        <summary className="field-row">
          <Server size={20} className="muted" aria-label="サーバー" />
          <span className="muted small">{engine.conn ? engine.conn.endpoint.label : "—"}</span>
        </summary>
        {draft?.map((ep, i) => (
          <div key={i} className="endpoint">
            <input value={ep.label} placeholder="名前" aria-label="名前" onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, label: e.target.value } : d)))} />
            <input value={ep.url} placeholder="https://…" aria-label="URL" onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, url: e.target.value } : d)))} />
            <IconButton icon={ArrowUp} label="優先する" disabled={i === 0} size={18} onClick={() => setDraft(swap(draft, i, i - 1))} />
            <IconButton icon={X} label="削除" size={18} onClick={() => setDraft(draft.filter((_, j) => j !== i))} />
          </div>
        ))}
        <div className="row end">
          <IconButton icon={Plus} label="追加" onClick={() => setDraft([...(draft ?? []), { label: "", url: "" }])} />
          <IconButton
            icon={Check}
            label="保存して再接続"
            variant="primary"
            busy={busy === "servers"}
            onClick={run("servers", async () => {
              await engine.setEndpoints((draft ?? []).filter((d) => d.url.trim()).map((d) => ({ label: d.label.trim() || d.url, url: d.url.trim() })));
              await engine.connect(true);
              await engine.sync();
            })}
          />
        </div>
      </details>

      <div className="row center">
        <IconButton icon={LogOut} label="この端末からログアウト" variant="danger" onClick={run("signout", signOut)} />
      </div>

      {link && <DeviceLinkSheet link={link} onClose={() => setLink(null)} />}
    </Screen>
  );
}

/** 新しい端末に見せる QR。期限までの残り時間を輪で表す */
function DeviceLinkSheet({ link, onClose }: { link: { id: string; url: string; exp: number }; onClose: () => void }) {
  const engine = useEngine();
  const [now, setNow] = useState(Date.now());
  const info = useLive((e) => e.accountInfo());
  const used = info && !info.links.some((l) => l.id === link.id);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // 新しい端末が使うとリンクは消える
  useEffect(() => {
    const t = setInterval(() => void engine.sync(), 3000);
    return () => clearInterval(t);
  }, [engine]);
  const left = Math.max(0, link.exp - now);

  function close() {
    if (!used && left > 0) void engine.cancelDeviceLink(link.id).catch(() => undefined);
    onClose();
  }

  return (
    <Sheet onClose={close}>
      <div className="share-panel">
        {used ? <Check size={64} className="ok" aria-label="完了" /> : left > 0 ? <Qr text={link.url} /> : <Clock size={48} className="muted" aria-label="期限切れ" />}
        {!used && left > 0 && <div className="muted">{`${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`}</div>}
        <IconButton icon={X} label="閉じる" variant="soft" onClick={close} />
      </div>
    </Sheet>
  );
}

function swap<T>(xs: T[], i: number, j: number) {
  const a = [...xs];
  [a[i], a[j]] = [a[j]!, a[i]!];
  return a;
}
