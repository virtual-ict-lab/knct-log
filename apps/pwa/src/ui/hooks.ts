import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { Engine } from "../lib/engine.ts";

export const EngineContext = createContext<Engine | null>(null);

export function useEngine(): Engine {
  const e = useContext(EngineContext);
  if (!e) throw new Error("EngineContext is missing");
  return e;
}

/** エンジンの変更通知ごとに増えるバージョン */
export function useEngineVersion() {
  const engine = useEngine();
  const [v, setV] = useState(0);
  useEffect(() => {
    const on = () => setV((x) => x + 1);
    engine.addEventListener("change", on);
    return () => engine.removeEventListener("change", on);
  }, [engine]);
  return v;
}

/** エンジンが変わるたびに再計算する非同期値 */
export function useLive<T>(f: (e: Engine) => Promise<T>, deps: unknown[] = []): T | undefined {
  const engine = useEngine();
  const v = useEngineVersion();
  const [value, setValue] = useState<T>();
  useEffect(() => {
    let alive = true;
    f(engine).then((x) => alive && setValue(x), console.error);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, v, ...deps]);
  return value;
}

function subscribeHash(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useRoute() {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash || "#/");
  const [path, query = ""] = hash.slice(1).split("?");
  return { parts: (path ?? "/").split("/").filter(Boolean), query: new URLSearchParams(query) };
}

export function go(path: string) {
  location.hash = path;
}

export function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

export function formatDay(ts: number) {
  return new Date(ts).toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" });
}

export function dayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function shortKey(pk: string) {
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}
