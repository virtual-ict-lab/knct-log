import { useState } from "react";
import { Camera, Check, Crown, Hourglass, KeyRound, Plus, ScanLine, Settings, Users, X } from "lucide-react";
import { ConnectionDot, Screen } from "./Layout.tsx";
import { Avatar, IconButton } from "./common.tsx";
import { Scanner } from "./Scanner.tsx";
import { go, useEngine, useLive } from "./hooks.ts";

export function Home() {
  const engine = useEngine();
  const groups = useLive((e) => e.groups());
  const [creating, setCreating] = useState(false);
  const [scan, setScan] = useState(false);
  const [name, setName] = useState("");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const g = await engine.createGroup(name.trim());
    setCreating(false);
    setName("");
    go(`/g/${g}`);
  }

  if (scan) return <Scanner onClose={() => setScan(false)} onResult={(h) => go(h)} />;

  return (
    <Screen
      title={<span className="logo small">knct-log</span>}
      actions={
        <>
          <ConnectionDot />
          <IconButton icon={ScanLine} label="招待 QR を読む" onClick={() => setScan(true)} />
          <IconButton icon={Settings} label="設定" onClick={() => go("/settings")} />
        </>
      }
    >
      <ul className="group-list">
        {groups?.map((g) => (
          <li key={g.group}>
            <button className="group-row" onClick={() => go(`/g/${g.group}`)}>
              <Avatar id={g.group} name={g.name} size={44} />
              <span className="group-name">{g.name ?? "…"}</span>
              <span className="group-meta">
                {g.joining ? (
                  <Hourglass size={18} aria-label="参加待ち" />
                ) : !g.hasKey ? (
                  <KeyRound size={18} aria-label="鍵の受け取り待ち" />
                ) : (
                  <>
                    {g.isAdmin && <Crown size={16} aria-label="管理者" />}
                    <Users size={16} aria-hidden />
                    <span>{g.members.length}</span>
                  </>
                )}
              </span>
            </button>
          </li>
        ))}
        <li>
          {creating ? (
            <form className="group-row new" onSubmit={create}>
              <span className="avatar placeholder" aria-hidden>
                <Users size={20} />
              </span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required autoFocus placeholder="グループ名" aria-label="グループ名" />
              <IconButton icon={X} label="やめる" onClick={() => setCreating(false)} />
              <IconButton icon={Check} label="作る" type="submit" variant="primary" disabled={!name.trim()} />
            </form>
          ) : (
            <button className="group-row add" onClick={() => setCreating(true)} aria-label="グループを作る" title="グループを作る">
              <span className="avatar placeholder" aria-hidden>
                <Plus size={22} />
              </span>
            </button>
          )}
        </li>
      </ul>
      {groups && groups.some((g) => g.hasKey) && (
        <button className="fab" aria-label="撮影" title="撮影" onClick={() => go("/capture")}>
          <Camera size={28} />
        </button>
      )}
    </Screen>
  );
}
