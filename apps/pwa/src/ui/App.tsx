import { useEffect } from "react";
import { go, useEngine, useEngineVersion, useRoute } from "./hooks.ts";
import { Setup } from "./Setup.tsx";
import { Home } from "./Home.tsx";
import { GroupPage } from "./GroupPage.tsx";
import { GroupSettings } from "./GroupSettings.tsx";
import { Capture } from "./Capture.tsx";
import { Join } from "./Join.tsx";
import { AppSettings } from "./AppSettings.tsx";

const SYNC_INTERVAL_MS = 15_000;

export function App() {
  const engine = useEngine();
  useEngineVersion();
  const { parts, query } = useRoute();

  // 表示中は定期的に同期。復帰時・オンライン復帰時は接続先も選び直す
  useEffect(() => {
    if (!engine.device) return;
    void engine.sync();
    const tick = () => document.visibilityState === "visible" && void engine.sync();
    const reconnect = () => {
      if (document.visibilityState !== "visible") return;
      void engine.connect(true).then(() => engine.sync());
    };
    const id = setInterval(tick, SYNC_INTERVAL_MS);
    document.addEventListener("visibilitychange", reconnect);
    window.addEventListener("online", reconnect);
    const onMsg = (e: MessageEvent) => e.data?.type === "sync" && void engine.sync();
    navigator.serviceWorker?.addEventListener("message", onMsg);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", reconnect);
      window.removeEventListener("online", reconnect);
      navigator.serviceWorker?.removeEventListener("message", onMsg);
    };
  }, [engine, engine.device]);

  if (!engine.device) return <Setup />;

  const [head, id, sub] = parts;
  switch (head) {
    case "g":
      if (!id) break;
      return sub === "settings" ? <GroupSettings group={id} /> : <GroupPage group={id} />;
    case "capture":
      return <Capture preselect={query.get("g")} />;
    case "join":
      return <Join g={query.get("g")} i={query.get("i")} t={query.get("t")} />;
    case "settings":
      return <AppSettings />;
  }
  if (head) go("/");
  return <Home />;
}
