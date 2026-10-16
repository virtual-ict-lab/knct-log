import { useState } from "react";
import { ArrowRight, FingerprintPattern, KeyRound, ScanLine } from "lucide-react";
import { PasskeyError, passkeySupported, webPasskey } from "../lib/passkey.ts";
import { ErrorNote, IconButton, useAction } from "./common.tsx";
import { Scanner } from "./Scanner.tsx";
import { go, useEngine } from "./hooks.ts";

function message(e: unknown) {
  if (e instanceof PasskeyError) {
    if (e.code === "cancelled") return null;
    if (e.code === "no-prf") return "このパスキーは鍵の保存に対応していません";
    return "この端末ではパスキーを使えません";
  }
  return (e as Error).message;
}

/** はじめての起動。名前を入れてパスキーで始める／パスキーでログイン／別の端末の QR を読む */
export function Welcome() {
  const engine = useEngine();
  const [name, setName] = useState("");
  const [scan, setScan] = useState(false);
  const [noPasskey, setNoPasskey] = useState(!passkeySupported());
  const { busy, error, setError, run } = useAction();

  const wrap = (f: () => Promise<void>) => async () => {
    try {
      await f();
    } catch (e) {
      const m = message(e);
      if (e instanceof PasskeyError && e.code !== "cancelled") setNoPasskey(true);
      if (m) throw new Error(m);
    }
  };

  if (scan) return <Scanner onClose={() => setScan(false)} onResult={(h) => go(h)} />;

  return (
    <div className="screen welcome">
      <main>
        <h1 className="logo">knct-log</h1>
        <form
          className="welcome-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run("create", wrap(() => engine.createAccount(name.trim(), webPasskey)))();
          }}
        >
          <input
            className="big-input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            maxLength={30}
            required
            autoFocus
            placeholder="なまえ"
            aria-label="表示名"
          />
          <button className="primary-round" type="submit" aria-label="パスキーで始める" title="パスキーで始める" disabled={!name.trim() || !!busy}>
            <FingerprintPattern size={34} />
          </button>
          {noPasskey && (
            <button
              type="button"
              className="link-btn"
              disabled={!name.trim() || !!busy}
              onClick={run("plain", () => engine.createAccount(name.trim(), null))}
              title="パスキーなしで始める（この端末だけ）"
            >
              パスキーなし <ArrowRight size={16} />
            </button>
          )}
        </form>
        <ErrorNote error={error} />
        <div className="welcome-alt">
          <div className="alt">
            <IconButton icon={KeyRound} label="パスキーでログイン" variant="soft" size={26} busy={busy === "signin"} onClick={run("signin", wrap(() => engine.signInWithPasskey(webPasskey)))} />
            <small>ログイン</small>
          </div>
          <div className="alt">
            <IconButton icon={ScanLine} label="ほかの端末の QR を読む" variant="soft" size={26} onClick={() => setScan(true)} />
            <small>QR</small>
          </div>
        </div>
      </main>
    </div>
  );
}
