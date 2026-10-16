import type { ReactNode } from "react";
import { ChevronLeft, CloudOff } from "lucide-react";
import { IconButton } from "./common.tsx";
import { go, useEngine } from "./hooks.ts";

export function Screen(props: { title: ReactNode; back?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="screen">
      <header className="bar">
        {props.back !== undefined ? <IconButton icon={ChevronLeft} label="戻る" size={26} onClick={() => go(props.back!)} /> : <span className="bar-spacer" />}
        <h1>{props.title}</h1>
        <div className="bar-actions">{props.actions}</div>
      </header>
      <main>{props.children}</main>
    </div>
  );
}

/** 接続先。つながっていれば色の点、つながらなければ雲のアイコン（理由は title に） */
export function ConnectionDot() {
  const engine = useEngine();
  const c = engine.conn;
  if (!c || engine.lastError)
    return (
      <span className="conn off" title={engine.lastError ?? "オフライン"} aria-label="オフライン">
        <CloudOff size={18} />
      </span>
    );
  return <span className={`conn ok ${c.serverId}`} title={`${c.endpoint.label}（${c.serverId}）`} aria-label={c.endpoint.label} />;
}
