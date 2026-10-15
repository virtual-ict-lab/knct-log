import { useEffect, useState } from "react";
import { Screen } from "./Layout.tsx";
import { go, shortKey, useEngine, useLive } from "./hooks.ts";

export function GroupSettings({ group }: { group: string }) {
  const engine = useEngine();
  const view = useLive((e) => e.groupView(group), [group]);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transferTo, setTransferTo] = useState("");
  const [successor, setSuccessor] = useState("");
  const [name, setName] = useState("");
  const [hours, setHours] = useState<[number, number]>([8, 23]);

  useEffect(() => {
    if (!view?.state) return;
    setName(view.name ?? "");
    setHours(view.state.settings.hours);
  }, [view?.name, view?.state?.settings.hours[0], view?.state?.settings.hours[1]]);

  if (!view) return <Screen title="" back={`/g/${group}`}>{null}</Screen>;
  const others = view.members.filter((m) => !m.isMe);
  const label = (m: (typeof view.members)[number]) => m.name ?? shortKey(m.pk);

  const run = (f: () => Promise<unknown>) => async () => {
    setError(null);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  async function invite() {
    const url = await engine.createInviteLink(group, location.origin);
    setLink(url);
    if (navigator.share) await navigator.share({ title: `${view!.name ?? "knct-log"}への招待`, url }).catch(() => undefined);
  }

  async function leave() {
    const needSuccessor = view!.isAdmin && others.length > 0;
    if (needSuccessor && !successor) return setError("後継の管理者を選んでください");
    if (!confirm("このグループを退会しますか？退会すると、これ以降の投稿は見られなくなります。")) return;
    const done = await engine.leave(group, needSuccessor ? successor : undefined);
    if (done) go("/");
    else setError("退会を送信待ちです。サーバーにつながると完了します。");
  }

  return (
    <Screen title="グループ設定" back={`/g/${group}`}>
      {error && <div className="banner warn">{error}</div>}

      {view.isAdmin && (
        <section className="card stack">
          <h2>グループ</h2>
          <label className="field">
            <span>名前</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </label>
          <div className="field">
            <span>撮影の通知を送る時間帯</span>
            <div className="row">
              <HourSelect value={hours[0]} onChange={(h) => setHours([h, hours[1]])} max={23} />
              <span>〜</span>
              <HourSelect value={hours[1]} onChange={(h) => setHours([hours[0], h])} min={1} max={24} />
              <span>時</span>
            </div>
          </div>
          <button
            className="btn"
            disabled={!name.trim() || hours[0] >= hours[1]}
            onClick={run(() => engine.updateGroupSettings(group, { name: name.trim() }, { hours }))}
          >
            保存
          </button>
        </section>
      )}

      <section className="card stack">
        <h2>メンバー（{view.members.length}/12）</h2>
        <ul className="members">
          {view.members.map((m) => (
            <li key={m.pk}>
              <span>{label(m)}</span>
              {m.isAdmin && <span className="badge subtle">管理者</span>}
              {m.isMe && <span className="badge subtle">自分</span>}
            </li>
          ))}
        </ul>
        <p className="hint">ほかのメンバーを削除することはできません。退会は本人だけができます。</p>
      </section>

      <section className="card stack">
        <h2>招待</h2>
        <button className="btn" disabled={view.members.length >= 12 || !view.hasKey} onClick={run(invite)}>
          招待リンクを作る
        </button>
        {link && (
          <div className="stack">
            <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn small" onClick={() => navigator.clipboard.writeText(link)}>
              コピー
            </button>
            <p className="hint">リンクは7日間有効です。リンクを知っている人は誰でも参加できるので、LINE などで直接渡してください。</p>
          </div>
        )}
        {view.invites.length > 0 && (
          <ul className="members">
            {view.invites.map((i) => (
              <li key={i.id}>
                <span className="hint">
                  有効期限 {i.exp ? new Date(i.exp).toLocaleDateString("ja-JP") : "なし"}
                </span>
                {(view.isAdmin || i.mine) && (
                  <button className="btn small" onClick={run(() => engine.revokeInvite(group, i.id))}>
                    無効にする
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.isAdmin && others.length > 0 && (
        <section className="card stack">
          <h2>管理者を移譲</h2>
          <select value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
            <option value="">選んでください</option>
            {others.map((m) => (
              <option key={m.pk} value={m.pk}>
                {label(m)}
              </option>
            ))}
          </select>
          <button
            className="btn"
            disabled={!transferTo}
            onClick={run(async () => {
              if (confirm("管理者を移譲しますか？元に戻すには新しい管理者に移譲し直してもらう必要があります。"))
                await engine.transferAdmin(group, transferTo);
            })}
          >
            移譲する
          </button>
        </section>
      )}

      <section className="card stack danger-zone">
        <h2>退会</h2>
        {view.isAdmin && others.length > 0 && (
          <label className="field">
            <span>あなたは管理者です。退会する前に後継者を選んでください。</span>
            <select value={successor} onChange={(e) => setSuccessor(e.target.value)}>
              <option value="">後継の管理者</option>
              {others.map((m) => (
                <option key={m.pk} value={m.pk}>
                  {label(m)}
                </option>
              ))}
            </select>
          </label>
        )}
        {others.length === 0 && <p className="hint">最後のメンバーが退会すると、グループは解散します。</p>}
        <button className="btn danger" onClick={run(leave)}>
          このグループを退会する
        </button>
      </section>
    </Screen>
  );
}

function HourSelect(props: { value: number; onChange: (h: number) => void; min?: number; max: number }) {
  const opts = [];
  for (let h = props.min ?? 0; h <= props.max; h++) opts.push(h);
  return (
    <select value={props.value} onChange={(e) => props.onChange(Number(e.target.value))}>
      {opts.map((h) => (
        <option key={h} value={h}>
          {h}
        </option>
      ))}
    </select>
  );
}
