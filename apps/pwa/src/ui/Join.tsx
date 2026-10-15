import { useEffect, useRef, useState } from "react";
import { Screen } from "./Layout.tsx";
import { go, useEngine } from "./hooks.ts";

export function Join(props: { g: string | null; i: string | null; t: string | null }) {
  const engine = useEngine();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const { g, i, t } = props;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!g || !i || !t) {
      setError("招待リンクが壊れています。");
      return;
    }
    engine.join(g, i, t).then(
      () => go(`/g/${g}`),
      (e) => setError((e as Error).message),
    );
  }, [engine, g, i, t]);

  return (
    <Screen title="グループに参加" back="/">
      <div className="empty">{error ? <p className="error">{error}</p> : <p>参加しています…</p>}</div>
    </Screen>
  );
}
