import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { openLocalDb } from "./lib/db.ts";
import { Engine } from "./lib/engine.ts";
import { defaultEndpoints } from "./lib/endpoints.ts";
import { followKeyboard } from "./lib/keyboard.ts";
import { App } from "./ui/App.tsx";
import { Insecure } from "./ui/Insecure.tsx";
import { EngineContext } from "./ui/hooks.ts";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

if (!isSecureContext) {
  // カメラ・パスキー・暗号（crypto.subtle）・Service Worker は HTTPS か localhost でしか使えない
  root.render(<Insecure />);
} else {
  registerSW({ immediate: true });
  followKeyboard();

  const db = await openLocalDb();
  const engine = new Engine(db);
  if ((await engine.endpoints()).length === 0) await engine.setEndpoints(defaultEndpoints());
  await engine.load();
  void engine.prune();

  root.render(
    <StrictMode>
      <EngineContext.Provider value={engine}>
        <App />
      </EngineContext.Provider>
    </StrictMode>,
  );
}
