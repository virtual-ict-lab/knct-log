import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { openLocalDb } from "./lib/db.ts";
import { Engine } from "./lib/engine.ts";
import { defaultEndpoints } from "./lib/endpoints.ts";
import { App } from "./ui/App.tsx";
import { EngineContext } from "./ui/hooks.ts";
import "./styles.css";

registerSW({ immediate: true });

const db = await openLocalDb();
const engine = new Engine(db);
if ((await engine.endpoints()).length === 0) await engine.setEndpoints(defaultEndpoints());
await engine.load();
void engine.prune();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EngineContext.Provider value={engine}>
      <App />
    </EngineContext.Provider>
  </StrictMode>,
);
