import { useEffect, useState } from "react";
import { Bell, Check, Crown, Link, LogOut, X } from "lucide-react";
import { Screen } from "./Layout.tsx";
import { Avatar, ErrorNote, IconButton, Sheet, useAction } from "./common.tsx";
import { go, shortKey, useEngine, useLive } from "./hooks.ts";

export function GroupSettings({ group }: { group: string }) {
  const engine = useEngine();
  const view = useLive((e) => e.groupView(group), [group]);
  const [name, setName] = useState("");
  const [hours, setHours] = useState<[number, number]>([8, 23]);
  const [pickSuccessor, setPickSuccessor] = useState(false);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    if (!view?.state) return;
    setName(view.name ?? "");
    setHours(view.state.settings.hours);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.name, view?.state?.settings.hours[0], view?.state?.settings.hours[1]]);

  if (!view) return <Screen title="" back={`/g/${group}`}>{null}</Screen>;
  const others = view.members.filter((m) => !m.isMe);
  const label = (m: (typeof view.members)[number]) => m.name ?? shortKey(m.pk);
  const dirty = name.trim() !== (view.name ?? "") || hours[0] !== view.state?.settings.hours[0] || hours[1] !== view.state?.settings.hours[1];

  async function leave(successor?: string) {
    if (!confirm("退会しますか？")) return;
    const done = await engine.leave(group, successor);
    if (done) go("/");
    else setError("サーバーにつながると退会が完了します");
  }

  return (
    <Screen title={view.name ?? ""} back={`/g/${group}`}>
      <ErrorNote error={error} />

      {view.isAdmin && (
        <>
        <h2 className="section-label">グループ</h2>
        <section className="card">
          <div className="field-row">
            <Avatar id={group} name={name || view.name} size={40} />
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} aria-label="グループ名" />
          </div>
          <div className="field-row hours-row">
            <Bell size={20} className="muted" />
            <span className="row-label">通知の時間帯</span>
            <span className="hours">
              <HourSelect value={hours[0]} onChange={(h) => setHours([h, hours[1]])} max={23} label="開始" />
              <span className="muted">–</span>
              <HourSelect value={hours[1]} onChange={(h) => setHours([hours[0], h])} min={1} max={24} label="終了" />
            </span>
          </div>
          <div className="row end">
            <IconButton
              icon={Check}
              label="保存"
              text="保存"
              variant="primary"
              disabled={!dirty || !name.trim() || hours[0] >= hours[1]}
              busy={busy === "save"}
              onClick={run("save", () => engine.updateGroupSettings(group, { name: name.trim() }, { hours }))}
            />
          </div>
        </section>
        </>
      )}

      <h2 className="section-label">
        メンバー {view.members.length} / 12
      </h2>
      <section className="card">
        <ul className="members">
          {view.members.map((m) => (
            <li key={m.pk}>
              <Avatar id={m.pk} name={m.name} size={36} />
              <span className={m.isMe ? "me" : ""}>{label(m)}</span>
              <span className="spacer" />
              {m.isAdmin ? (
                <span className="admin-tag">
                  <Crown size={18} className="crown" />
                  管理者
                </span>
              ) : (
                view.isAdmin && (
                  <IconButton
                    icon={Crown}
                    label={`${label(m)} に管理者を移す`}
                    variant="soft"
                    size={18}
                    busy={busy === `xfer-${m.pk}`}
                    onClick={run(`xfer-${m.pk}`, async () => {
                      if (confirm(`${label(m)} に管理者を移しますか？`)) await engine.transferAdmin(group, m.pk);
                    })}
                  />
                )
              )}
            </li>
          ))}
        </ul>
        {view.isAdmin && others.length > 0 && <div className="muted small hint">王冠を押すと管理者を移せます</div>}
      </section>

      {view.invites.length > 0 && (
        <>
        <h2 className="section-label">有効な招待リンク</h2>
        <section className="card">
          <ul className="members">
            {view.invites.map((i) => (
              <li key={i.id}>
                <Link size={18} className="muted" aria-label="招待リンク" />
                <span className="muted">{i.exp ? `${new Date(i.exp).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })} まで` : "期限なし"}</span>
                <span className="spacer" />
                {(view.isAdmin || i.mine) && (
                  <IconButton icon={X} label="招待を無効にする" onClick={run("revoke", () => engine.revokeInvite(group, i.id))} />
                )}
              </li>
            ))}
          </ul>
        </section>
        </>
      )}

      <div className="row center">
        <IconButton
          icon={LogOut}
          label="退会"
          text="グループを退会"
          variant="danger"
          size={22}
          onClick={() => (view.isAdmin && others.length > 0 ? setPickSuccessor(true) : void run("leave", () => leave())())}
        />
      </div>

      {pickSuccessor && (
        <Sheet onClose={() => setPickSuccessor(false)}>
          <div className="sheet-title">次の管理者を選んで退会</div>
          <ul className="members pick">
            {others.map((m) => (
              <li key={m.pk}>
                <button
                  className="member-pick"
                  onClick={() => {
                    setPickSuccessor(false);
                    void run("leave", () => leave(m.pk))();
                  }}
                >
                  <Avatar id={m.pk} name={m.name} size={36} />
                  <span>{label(m)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
    </Screen>
  );
}

function HourSelect(props: { value: number; onChange: (h: number) => void; min?: number; max: number; label: string }) {
  const opts = [];
  for (let h = props.min ?? 0; h <= props.max; h++) opts.push(h);
  return (
    <select value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} aria-label={props.label}>
      {opts.map((h) => (
        <option key={h} value={h}>
          {h}:00
        </option>
      ))}
    </select>
  );
}
