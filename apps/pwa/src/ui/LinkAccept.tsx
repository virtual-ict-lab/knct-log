import { useEffect, useRef, useState } from "react";
import { RotateCw, X } from "lucide-react";
import { ErrorNote, IconButton, Spinner } from "./common.tsx";
import { go, useEngine } from "./hooks.ts";

/** 既存の端末が表示した QR から、アカウントをこの端末に取り込む */
export function LinkAccept(props: { a: string | null; u: string | null; k: string | null }) {
  const engine = useEngine();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const started = useRef(-1);
  const { a, u, k } = props;

  useEffect(() => {
    if (started.current === attempt) return;
    started.current = attempt;
    if (!a || !u || !k) return setError("リンクが壊れています");
    if (engine.me === a) return go("/");
    if (engine.account) return setError("この端末はすでに別のアカウントを使っています");
    setError(null);
    engine.acceptLink(a, u, k).then(
      () => go("/"),
      (e) => setError((e as Error).message),
    );
  }, [engine, a, u, k, attempt]);

  return (
    <div className="screen welcome">
      <main className="stack-center">
        {error ? (
          <>
            <ErrorNote error={error} />
            <div className="row">
              <IconButton icon={X} label="やめる" variant="soft" onClick={() => go("/")} />
              {!engine.account && <IconButton icon={RotateCw} label="もう一度" variant="primary" onClick={() => setAttempt((x) => x + 1)} />}
            </div>
          </>
        ) : (
          <Spinner size={40} />
        )}
      </main>
    </div>
  );
}
