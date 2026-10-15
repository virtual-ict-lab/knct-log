import type { ReactNode } from "react";
import { go, useEngine } from "./hooks.ts";

export function Screen(props: { title: ReactNode; back?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="screen">
      <header className="bar">
        {props.back !== undefined ? (
          <button className="icon-btn" aria-label="戻る" onClick={() => go(props.back!)}>
            ‹
          </button>
        ) : (
          <span className="bar-spacer" />
        )}
        <h1>{props.title}</h1>
        <div className="bar-actions">{props.actions}</div>
      </header>
      <ConnectionBanner />
      <main>{props.children}</main>
    </div>
  );
}

function ConnectionBanner() {
  const engine = useEngine();
  if (engine.lastError) return <div className="banner warn">{engine.lastError}</div>;
  return null;
}

export function ConnectionChip() {
  const engine = useEngine();
  const c = engine.conn;
  return (
    <span className={`chip ${c ? "ok" : "off"}`} title={c?.endpoint.url}>
      {c ? c.endpoint.label : "オフライン"}
    </span>
  );
}
