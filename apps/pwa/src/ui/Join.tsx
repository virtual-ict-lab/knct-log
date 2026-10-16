import { useEffect, useRef, useState } from "react";
import { Screen } from "./Layout.tsx";
import { ErrorNote, Spinner } from "./common.tsx";
import { go, useEngine } from "./hooks.ts";

export function Join(props: { g: string | null; i: string | null; t: string | null }) {
  const engine = useEngine();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const { g, i, t } = props;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!g || !i || !t) return setError("招待リンクが壊れています");
    engine.join(g, i, t).then(
      () => go(`/g/${g}`),
      (e) => setError((e as Error).message),
    );
  }, [engine, g, i, t]);

  return (
    <Screen title="" back="/">
      <div className="stack-center">{error ? <ErrorNote error={error} /> : <Spinner size={40} />}</div>
    </Screen>
  );
}
