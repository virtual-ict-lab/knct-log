import { fromB64u, toB64u } from "./bytes.ts";
import { sha256 } from "./crypto.ts";
import { type Header, MAX_MEMBERS, type VerifiedRecord, isControlKind } from "./record.ts";

export interface Member {
  pk: string;
  kx: string;
  /** このメンバーを有効にした group.create / member.join の ID */
  since: string;
}

export interface Invite {
  author: string;
  th: string;
  exp?: number;
  revoked: boolean;
}

export interface Epoch {
  id: string;
  parent: string | null;
  author: string;
}

export interface GroupSettings {
  /** 毎時プロンプトを送る時間帯 [開始, 終了)（ローカル時刻の時） */
  hours: [number, number];
  utcOffsetMin: number;
  /** グループ名・アイコンを変えられる人。"members" のとき管理者以外のメンバーも変えられる（既定は管理者のみ） */
  editableBy: "admin" | "members";
  /** 暗号化された名前などを持つ group.settings レコード */
  recordId?: string;
}

export interface GroupState {
  group: string;
  createId: string | null;
  admin: string | null;
  dissolved: boolean;
  members: Map<string, Member>;
  invites: Map<string, Invite>;
  epochs: Map<string, Epoch>;
  /** 現 epoch。ルートから「ID が最小の子」をたどった葉 */
  currentEpoch: string | null;
  /** 現 epoch が覆っていない退会。空でなければ鍵のローテーションが必要 */
  uncoveredLeaves: string[];
  settings: GroupSettings;
  applied: Set<string>;
  rejected: Map<string, string>;
  /** 依存先が欠けていて評価できないレコード */
  pending: Set<string>;
  /** 有効な制御レコードのうち、他から deps で参照されていないもの。新しい制御レコードの deps に使う */
  heads: string[];
}

export const DEFAULT_SETTINGS: GroupSettings = { hours: [8, 23], utcOffsetMin: 9 * 60, editableBy: "admin" };

type Ctl = Pick<VerifiedRecord, "id" | "header">;

function compare(a: Ctl, b: Ctl): number {
  return a.header.ts - b.header.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * 制御レコードの集合からグループ状態を決定的に導出する。
 * 結果は集合だけで決まり、到着順には依存しない（deps による因果順 → ts → id の順で適用する）。
 */
export async function deriveGroupState(group: string, records: Iterable<Ctl>): Promise<GroupState> {
  const ctl = new Map<string, Ctl>();
  for (const r of records) if (r.header.group === group && isControlKind(r.header.kind)) ctl.set(r.id, r);

  const tokenHash = new Map<string, string>();
  for (const r of ctl.values()) {
    if (r.header.kind === "member.join") {
      const token = r.header.body!.token as string;
      tokenHash.set(r.id, toB64u(await sha256(fromB64u(token))));
    }
  }

  const state: GroupState = {
    group,
    createId: null,
    admin: null,
    dissolved: false,
    members: new Map(),
    invites: new Map(),
    epochs: new Map(),
    currentEpoch: null,
    uncoveredLeaves: [],
    settings: { ...DEFAULT_SETTINGS },
    applied: new Set(),
    rejected: new Map(),
    pending: new Set(),
    heads: [],
  };

  // 因果順のトポロジカルソート（同順位は ts → id）。
  const indeg = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const r of ctl.values()) {
    let n = 0;
    for (const d of r.header.deps) {
      if (!ctl.has(d)) continue;
      n++;
      (children.get(d) ?? children.set(d, []).get(d)!).push(r.id);
    }
    indeg.set(r.id, n);
  }
  const missing = (r: Ctl) => r.header.deps.some((d) => !ctl.has(d));
  const ready = [...ctl.values()].filter((r) => indeg.get(r.id) === 0);
  const ancestors = new Map<string, Set<string>>();
  const leaves: string[] = [];

  while (ready.length > 0) {
    ready.sort(compare);
    const r = ready.shift()!;
    for (const c of children.get(r.id) ?? []) {
      const n = indeg.get(c)! - 1;
      indeg.set(c, n);
      if (n === 0) ready.push(ctl.get(c)!);
    }
    const blocked = missing(r) || r.header.deps.some((d) => state.pending.has(d));
    if (blocked) {
      state.pending.add(r.id);
      continue;
    }
    const anc = new Set<string>();
    for (const d of r.header.deps) {
      anc.add(d);
      for (const a of ancestors.get(d) ?? []) anc.add(a);
    }
    ancestors.set(r.id, anc);

    const reason = apply(state, r, tokenHash);
    if (reason) {
      state.rejected.set(r.id, reason);
    } else {
      state.applied.add(r.id);
      if (r.header.kind === "member.leave") leaves.push(r.id);
    }
  }
  // 循環した残り（通常は起こらない）も pending 扱い
  for (const id of ctl.keys()) if (!state.applied.has(id) && !state.rejected.has(id)) state.pending.add(id);

  // 現 epoch：ルートから ID 最小の子をたどる
  if (state.createId) {
    let cur = state.createId;
    for (;;) {
      let next: string | null = null;
      for (const e of state.epochs.values()) if (e.parent === cur && (next === null || e.id < next)) next = e.id;
      if (next === null) break;
      cur = next;
    }
    state.currentEpoch = cur;
    const covered = ancestors.get(cur) ?? new Set();
    state.uncoveredLeaves = state.dissolved ? [] : leaves.filter((l) => !covered.has(l));
  }

  const referenced = new Set<string>();
  for (const id of state.applied) for (const d of ctl.get(id)!.header.deps) referenced.add(d);
  state.heads = [...state.applied].filter((id) => !referenced.has(id)).sort();
  return state;
}

function apply(s: GroupState, r: Ctl, tokenHash: Map<string, string>): string | null {
  const h = r.header;
  const body = h.body ?? {};
  if (h.kind === "group.create") {
    if (s.createId) return "group already created";
    if (h.deps.length > 0) return "group.create must not have deps";
    s.createId = r.id;
    s.admin = h.author;
    s.members.set(h.author, { pk: h.author, kx: body.kx as string, since: r.id });
    s.epochs.set(r.id, { id: r.id, parent: null, author: h.author });
    return null;
  }
  if (!s.createId) return "group does not exist";
  if (s.dissolved) return "group dissolved";

  const isMember = s.members.has(h.author);
  const isAdmin = s.admin === h.author;
  switch (h.kind) {
    case "group.settings": {
      if (!isAdmin) {
        // 管理者以外は、editableBy が "members" のときに限り、名前とアイコン（ct）だけを変えられる。
        // 公開フィールド（hours / utcOffsetMin / editableBy）を含むレコードは管理者のものだけが有効。
        if (!isMember) return "only members can change settings";
        if (s.settings.editableBy !== "members") return "only admin can change settings";
        if (Object.keys(body).length > 0) return "members can only change name and icon";
      }
      if (!s.epochs.has(h.epoch!)) return "unknown epoch";
      const hours = body.hours as [number, number] | undefined;
      const off = body.utcOffsetMin as number | undefined;
      const by = body.editableBy as "admin" | "members" | undefined;
      s.settings = {
        hours: hours ?? s.settings.hours,
        utcOffsetMin: off ?? s.settings.utcOffsetMin,
        editableBy: by ?? s.settings.editableBy,
        recordId: r.id,
      };
      return null;
    }
    case "invite": {
      if (!isMember) return "only members can invite";
      s.invites.set(r.id, { author: h.author, th: body.th as string, exp: body.exp as number | undefined, revoked: false });
      return null;
    }
    case "invite.revoke": {
      const inv = s.invites.get(body.invite as string);
      if (!inv) return "unknown invite";
      if (!isAdmin && inv.author !== h.author) return "only admin or inviter can revoke";
      inv.revoked = true;
      return null;
    }
    case "member.join": {
      const inviteId = body.invite as string;
      if (!h.deps.includes(inviteId)) return "join must depend on invite";
      const inv = s.invites.get(inviteId);
      if (!inv) return "unknown invite";
      if (inv.revoked) return "invite revoked";
      if (inv.exp !== undefined && h.ts > inv.exp) return "invite expired";
      if (tokenHash.get(r.id) !== inv.th) return "invalid invite token";
      if (isMember) return "already a member";
      if (s.members.size >= MAX_MEMBERS) return "group is full";
      s.members.set(h.author, { pk: h.author, kx: body.kx as string, since: r.id });
      return null;
    }
    case "member.leave": {
      if (!isMember) return "not a member";
      const successor = body.successor as string | undefined;
      if (isAdmin && s.members.size > 1) {
        if (!successor || successor === h.author || !s.members.has(successor))
          return "admin must name a current member as successor";
        s.admin = successor;
      } else if (successor !== undefined) {
        return "only admin can name a successor";
      }
      s.members.delete(h.author);
      if (s.members.size === 0) {
        s.dissolved = true;
        s.admin = null;
      }
      return null;
    }
    case "admin.transfer": {
      if (!isAdmin) return "only admin can transfer";
      const to = body.to as string;
      if (to === h.author || !s.members.has(to)) return "transfer target must be another member";
      s.admin = to;
      return null;
    }
    case "key.rotate": {
      if (!isMember) return "not a member";
      const parent = body.parent as string;
      if (!h.deps.includes(parent)) return "rotate must depend on parent epoch";
      if (!s.epochs.has(parent)) return "unknown parent epoch";
      s.epochs.set(r.id, { id: r.id, parent, author: h.author });
      return null;
    }
    default:
      return `not a control kind: ${h.kind}`;
  }
}

export type Admission = { ok: true } | { ok: false; missing: string[] } | { ok: false; reason: string };

/**
 * クライアントから直接届いたコンテンツ系レコード（key.wrap / profile / post）を受け入れてよいか。
 * 制御レコードは deriveGroupState に追加して applied に入るかで判断する。
 */
export function admitContent(s: GroupState, h: Header): Admission {
  if (!s.createId) return { ok: false, missing: [] };
  if (s.dissolved) return { ok: false, reason: "group dissolved" };
  if (!s.members.has(h.author)) return { ok: false, reason: "not a member" };
  if (!h.epoch || !s.epochs.has(h.epoch)) return { ok: false, missing: h.epoch ? [h.epoch] : [] };
  if (h.kind === "key.wrap" && !s.members.has(h.body!.to as string)) return { ok: false, reason: "wrap target is not a member" };
  return { ok: true };
}

/** 新しく作る制御レコードを状態に加えたときの判定 */
export async function admitControl(group: string, existing: Iterable<Ctl>, rec: Ctl): Promise<Admission> {
  const s = await deriveGroupState(group, [...existing, rec]);
  if (s.applied.has(rec.id)) return { ok: true };
  const reason = s.rejected.get(rec.id);
  if (reason) return { ok: false, reason };
  const known = new Set([...existing].map((r) => r.id));
  return { ok: false, missing: rec.header.deps.filter((d) => !known.has(d)) };
}
