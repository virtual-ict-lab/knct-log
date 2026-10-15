import { useState } from "react";
import { ConnectionChip, Screen } from "./Layout.tsx";
import { go, useEngine, useLive } from "./hooks.ts";

export function Home() {
  const engine = useEngine();
  const groups = useLive((e) => e.groups());
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const g = await engine.createGroup(name.trim());
    setCreating(false);
    setName("");
    go(`/g/${g}`);
  }

  return (
    <Screen
      title="knct-log"
      actions={
        <>
          <ConnectionChip />
          <button className="icon-btn" aria-label="設定" onClick={() => go("/settings")}>
            ⚙
          </button>
        </>
      }
    >
      <section className="stack">
        {groups?.length === 0 && (
          <div className="empty">
            <p>まだグループがありません。</p>
            <p className="hint">グループを作るか、招待リンクを開いて参加しましょう。</p>
          </div>
        )}
        {groups?.map((g) => (
          <button key={g.group} className="card group-card" onClick={() => go(`/g/${g.group}`)}>
            <span className="group-name">{g.name ?? (g.joining ? "参加手続き中…" : "名前を取得中…")}</span>
            <span className="group-meta">
              {g.joining ? (
                <span className="badge">承認待ち</span>
              ) : !g.hasKey ? (
                <span className="badge">鍵の受け取り待ち</span>
              ) : (
                <span>{g.members.length}人</span>
              )}
              {g.isAdmin && <span className="badge subtle">管理者</span>}
            </span>
          </button>
        ))}

        {creating ? (
          <form className="card stack" onSubmit={create}>
            <label className="field">
              <span>グループ名</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required autoFocus />
            </label>
            <div className="row">
              <button type="button" className="btn" onClick={() => setCreating(false)}>
                やめる
              </button>
              <button className="btn primary" disabled={!name.trim()}>
                作る
              </button>
            </div>
          </form>
        ) : (
          <button className="btn" onClick={() => setCreating(true)}>
            ＋ グループを作る
          </button>
        )}
      </section>
      {groups && groups.some((g) => g.hasKey) && (
        <button className="fab" aria-label="撮影" onClick={() => go("/capture")}>
          ●
        </button>
      )}
    </Screen>
  );
}
