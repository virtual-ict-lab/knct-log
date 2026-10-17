import {
  type AccountDoc,
  type Actor,
  ApiClient,
  ApiError,
  type DeviceKeys,
  type Envelope,
  type GroupMeta,
  LINK_TTL_MS,
  type GroupState,
  type PostContent,
  type Profile,
  isIcon,
  type ReactionContent,
  type ReplyContent,
  type PostEditContent,
  type Unlock,
  type VerifiedRecord,
  createGroup,
  createInvite,
  createPost,
  createReaction,
  createReply,
  deletePost,
  editPost,
  cryptoKeySigner,
  decryptBlob,
  deriveGroupState,
  deriveKek,
  encryptBlob,
  fromB64u,
  generateAccountSecret,
  importAccountKeys,
  joinGroup,
  leaveGroup,
  makeUnlock,
  newAmk,
  openAccountDoc,
  openBundle,
  openContent,
  openRecord,
  openUnlock,
  randomBytes,
  revokeInvite,
  rotateKey,
  sealBundle,
  setProfile,
  signAccountDoc,
  toB64u,
  transferAdmin,
  unwrapGroupKey,
  updateSettings,
  withUnlock,
  wrapFor,
} from "@knct-log/core";
import type { DB, Endpoint, LocalRecord, StoredAccount } from "./db.ts";
import { pickEndpoint } from "./endpoints.ts";
import type { Passkey } from "./passkey.ts";

/** 他メンバーが先に対応するのを待つ時間（管理者は即時）。重複は無害だが減らしたい。 */
const HELP_DELAY_MS = 2 * 60 * 1000;

export interface Connection {
  endpoint: Endpoint;
  serverId: string;
  api: ApiClient;
}

export interface GroupView {
  group: string;
  name: string | null;
  icon?: string;
  /** 名前・アイコンを変えられる（管理者、または管理者が許可したメンバー） */
  canEdit: boolean;
  joining: boolean;
  state: GroupState | null;
  isMember: boolean;
  isAdmin: boolean;
  hasKey: boolean;
  members: { pk: string; name: string | null; isAdmin: boolean; isMe: boolean }[];
  invites: { id: string; exp?: number; mine: boolean }[];
}

export interface PostView {
  id: string;
  group: string;
  author: string;
  authorName: string | null;
  ts: number;
  exp: number;
  blobId: string;
  content: PostContent | null;
  pending: boolean;
  /** 絵文字ごとの数。mine は自分が付けたもの */
  reactions: { emoji: string; count: number; mine: boolean }[];
  replies: { id: string; author: string; authorName: string | null; text: string; ts: number }[];
}

export interface AccountInfo {
  passkeys: number;
  links: { id: string; exp?: number }[];
}

type Picker = (endpoints: Endpoint[]) => Promise<{ endpoint: Endpoint; serverId: string } | null>;

export class Engine extends EventTarget {
  readonly db: DB;
  private readonly fetchFn?: typeof fetch;
  private readonly picker: Picker;
  account: StoredAccount | null = null;
  conn: Connection | null = null;
  lastError: string | null = null;
  private syncing: Promise<void> | null = null;
  /** 復号済みの内容（レコードは不変なので ID で覚えておける） */
  private readonly plain = new Map<string, unknown>();

  constructor(db: DB, opts: { fetch?: typeof fetch; picker?: Picker } = {}) {
    super();
    this.db = db;
    this.fetchFn = opts.fetch;
    this.picker = opts.picker ?? pickEndpoint;
  }

  private changed() {
    this.dispatchEvent(new Event("change"));
  }

  get me() {
    return this.account?.keys.signPub ?? null;
  }

  get name() {
    return this.account?.name ?? "";
  }

  get icon() {
    return this.account?.icon;
  }

  /** 表示用アイコンの覚え書き（アカウントの公開鍵 / グループ ID → data URL）。Avatar が引く */
  readonly icons = new Map<string, string>();

  private rememberIcon(id: string, icon: string | undefined) {
    if (icon && isIcon(icon)) this.icons.set(id, icon);
    else this.icons.delete(id);
  }

  private profile(): Profile {
    return this.icon ? { name: this.name, icon: this.icon } : { name: this.name };
  }

  private actor(): Actor & { kx: CryptoKeyPair } {
    const k = this.account!.keys;
    return { signer: cryptoKeySigner(k.signPub, k.sign.privateKey), kxPub: k.kxPub, kx: k.kx };
  }

  // ---------- アカウント ----------

  async load() {
    this.account = ((await this.db.get("meta", "account")) as StoredAccount | undefined) ?? null;
    this.changed();
  }

  private async saveAccount(a: StoredAccount) {
    const switched = this.account?.keys.signPub !== a.keys.signPub;
    await this.db.put("meta", a, "account");
    this.account = a;
    if (switched) this.conn = null; // 認証に使う鍵が変わった
    this.changed();
  }

  private async storeAccount(keys: DeviceKeys, name: string, icon: string | undefined, amk: Uint8Array<ArrayBuffer>, doc: Envelope, docTs: number, dirty: boolean) {
    await this.saveAccount({ keys, name, icon, amk, doc, docTs, dirty });
  }

  /** 新しいアカウントを作る。passkey があれば、その PRF で鍵をバックアップする（なければこの端末だけ） */
  async createAccount(name: string, passkey: Passkey | null) {
    const secret = await generateAccountSecret(name);
    const amk = newAmk();
    const unlocks: Unlock[] = [];
    if (passkey) {
      const { credId, prf } = await passkey.register(secret.signPub, name);
      unlocks.push(await makeUnlock(amk, secret.signPub, "passkey", credId, await deriveKek(prf, "passkey")));
    }
    const keys = await importAccountKeys(secret);
    const doc: AccountDoc = { v: 1, account: secret.signPub, ts: Date.now(), bundle: await sealBundle(amk, secret), unlocks };
    const signer = cryptoKeySigner(keys.signPub, keys.sign.privateKey);
    await this.storeAccount(keys, name, undefined, amk, await signAccountDoc(signer, doc), doc.ts, true);
    void this.sync();
  }

  /** パスキーでログインする（別の端末で作ったアカウントをこの端末に取り込む） */
  async signInWithPasskey(passkey: Passkey) {
    const { credId, account, prf } = await passkey.authenticate();
    const found = await this.findAccountDoc(account, (d) => d.unlocks.some((u) => u.id === credId));
    if (!found) throw new Error("アカウントが見つかりません");
    const u = found.doc.unlocks.find((x) => x.id === credId)!;
    const amk = await openUnlock(found.doc, u, await deriveKek(prf, "passkey"));
    await this.restore(found.doc, found.env, amk);
  }

  /** 既存の端末が出した QR（リンク）で取り込む。リンクはサーバー間の同期を待つことがある */
  async acceptLink(account: string, id: string, secret: string, waitMs = 60_000) {
    const found = await this.findAccountDoc(account, (d) => d.unlocks.some((u) => u.id === id), waitMs);
    const u = found?.doc.unlocks.find((x) => x.id === id);
    if (!found || !u || (u.exp !== undefined && u.exp < Date.now())) throw new Error("リンクの期限が切れています");
    const amk = await openUnlock(found.doc, u, await deriveKek(fromB64u(secret), "link"));
    await this.restore(found.doc, found.env, amk);
    // 使ったリンクは消す
    await this.mutateDoc((d) => ({ unlocks: withUnlock(d, null, id) })).catch(() => undefined);
  }

  private async restore(doc: AccountDoc, env: Envelope, amk: Uint8Array<ArrayBuffer>) {
    const secret = await openBundle(amk, doc);
    await this.storeAccount(await importAccountKeys(secret), secret.name, secret.icon, amk, env, doc.ts, false);
    await this.sync();
  }

  /** 登録されているサーバーを順に見て、条件を満たす最新の文書を返す */
  private async findAccountDoc(account: string, ok: (d: AccountDoc) => boolean, waitMs = 0) {
    const f = this.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const end = Date.now() + waitMs;
    for (;;) {
      let best: { doc: AccountDoc; env: Envelope } | null = null;
      for (const ep of await this.endpoints()) {
        try {
          const res = await f(`${ep.url.replace(/\/+$/, "")}/v1/accounts/${account}`, { signal: AbortSignal.timeout(5000) });
          if (!res.ok) continue;
          const env = (await res.json()) as Envelope;
          const doc = await openAccountDoc(env);
          if (doc.account === account && ok(doc) && (!best || doc.ts > best.doc.ts)) best = { doc, env };
        } catch {
          // 届かないサーバーは飛ばす
        }
      }
      if (best || Date.now() >= end) return best;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  /**
   * アカウント文書を変更して公開する。サーバーの最新版に対して変更を当て、競合したらやり直す。
   * strict のときはサーバーに届くまで失敗扱い（QR リンクなど、すぐ使うもの）。
   */
  private async mutateDoc(
    f: (doc: AccountDoc, secret: () => Promise<import("@knct-log/core").AccountSecret>) => Promise<Partial<AccountDoc>> | Partial<AccountDoc>,
    strict = false,
  ) {
    for (let attempt = 0; ; attempt++) {
      const a = this.account!;
      let env = a.doc;
      const conn = await this.connect();
      const remote = conn ? await conn.api.getAccount(a.keys.signPub).catch(() => null) : null;
      if (remote) {
        const r = await openAccountDoc(remote);
        if (r.ts > a.docTs) env = remote;
      }
      const doc = await openAccountDoc(env);
      const patch = await f(doc, () => openBundle(a.amk, doc));
      const next: AccountDoc = { ...doc, ...patch, ts: Math.max(Date.now(), doc.ts + 1) };
      const signed = await signAccountDoc(this.actor().signer, next);
      await this.saveAccount({ ...this.account!, doc: signed, docTs: next.ts, dirty: true });
      try {
        await this.publishAccount(strict);
        return next;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && attempt < 3) continue;
        throw e;
      }
    }
  }

  private async publishAccount(strict: boolean) {
    const a = this.account;
    if (!a?.dirty) return;
    const conn = await this.connect();
    if (!conn) {
      if (strict) throw new Error("サーバーに接続できません");
      return;
    }
    await conn.api.putAccount(a.doc);
    await this.saveAccount({ ...this.account!, dirty: false });
  }

  /** 他の端末での変更（名前・パスキー）を取り込む */
  private async refreshAccount(conn: Connection) {
    const a = this.account!;
    if (a.dirty) {
      try {
        await this.publishAccount(false);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) throw e;
        await this.saveAccount({ ...a, dirty: false }); // 新しい方を下で取り込む
      }
      return;
    }
    const remote = await conn.api.getAccount(a.keys.signPub);
    if (!remote) return void (await this.saveAccount({ ...a, dirty: true }));
    const doc = await openAccountDoc(remote);
    if (doc.ts <= a.docTs) return;
    const secret = await openBundle(a.amk, doc);
    if (secret.name !== a.name || secret.icon !== a.icon) await this.forgetProfiles();
    await this.saveAccount({ ...a, name: secret.name, icon: secret.icon, doc: remote, docTs: doc.ts });
  }

  private async forgetProfiles() {
    for (const g of await this.db.getAll("groups")) await this.db.delete("meta", `profile/${g.group}`);
  }

  async accountInfo(): Promise<AccountInfo | null> {
    if (!this.account) return null;
    const doc = await openAccountDoc(this.account.doc);
    const now = Date.now();
    return {
      passkeys: doc.unlocks.filter((u) => u.kind === "passkey").length,
      links: doc.unlocks.filter((u) => u.kind === "link" && (u.exp ?? 0) > now).map((u) => ({ id: u.id, exp: u.exp })),
    };
  }

  async rename(name: string) {
    await this.updateMe({ name });
  }

  /** 自分の表示名・アイコンを変える。icon は null で外す。アカウント文書に入れて端末間で引き継ぐ */
  async updateMe(patch: { name?: string; icon?: string | null }) {
    if (patch.icon && !isIcon(patch.icon)) throw new Error("アイコンが大きすぎます");
    const name = patch.name ?? this.name;
    const icon = patch.icon === undefined ? this.icon : (patch.icon ?? undefined);
    await this.mutateDoc(async (_d, secret) => {
      const { icon: _old, ...s } = await secret();
      return { bundle: await sealBundle(this.account!.amk, icon ? { ...s, name, icon } : { ...s, name }) };
    });
    await this.saveAccount({ ...this.account!, name, icon });
    await this.forgetProfiles(); // 各グループのプロフィールは次の maintain で出し直す
  }

  /** この端末のパスキーを追加する（パスキーなしで作ったアカウントや、別の端末のパスキー） */
  async addPasskey(passkey: Passkey) {
    const { credId, prf } = await passkey.register(this.me!, this.name);
    const u = await makeUnlock(this.account!.amk, this.me!, "passkey", credId, await deriveKek(prf, "passkey"));
    await this.mutateDoc((d) => ({ unlocks: withUnlock(d, u) }), true);
  }

  /** 新しい端末に渡すリンク（QR）を作る。10 分で無効になる */
  async createDeviceLink(origin: string) {
    const id = toB64u(randomBytes(12));
    const secret = randomBytes(32);
    const exp = Date.now() + LINK_TTL_MS;
    const u = await makeUnlock(this.account!.amk, this.me!, "link", id, await deriveKek(secret, "link"), exp);
    await this.mutateDoc((d) => ({ unlocks: withUnlock(d, u) }), true);
    const params = new URLSearchParams({ a: this.me!, u: id, k: toB64u(secret) });
    return { id, exp, url: `${origin}/#/link?${params}` };
  }

  async cancelDeviceLink(id: string) {
    await this.mutateDoc((d) => ({ unlocks: withUnlock(d, null, id) }));
  }

  /** この端末からアカウントを消す（サーバーのアカウントとグループはそのまま。接続先の設定は残す） */
  async signOut() {
    const endpoints = await this.endpoints();
    const tx = this.db.transaction(["meta", "records", "keys", "cursors", "outbox", "blobs", "groups"], "readwrite");
    for (const name of tx.objectStoreNames) await tx.objectStore(name).clear();
    await tx.objectStore("meta").put(endpoints, "endpoints");
    await tx.done;
    this.account = null;
    this.conn = null;
    this.plain.clear();
    this.changed();
  }

  /** サーバーにある自分のグループを、この端末にも登録する（別の端末で参加したもの） */
  private async adoptGroups(conn: Connection) {
    const { groups } = await conn.api.myGroups();
    for (const g of groups) {
      if (g.dissolved || (await this.db.get("groups", g.group))) continue;
      await this.db.put("groups", { group: g.group, addedAt: Date.now() });
    }
  }

  async endpoints(): Promise<Endpoint[]> {
    return ((await this.db.get("meta", "endpoints")) as Endpoint[] | undefined) ?? [];
  }

  async setEndpoints(eps: Endpoint[]) {
    await this.db.put("meta", eps, "endpoints");
    this.conn = null;
    this.changed();
  }

  // ---------- 接続 ----------

  async connect(force = false): Promise<Connection | null> {
    if (this.conn && !force) return this.conn;
    const picked = await this.picker(await this.endpoints());
    const prev = this.conn?.serverId;
    this.conn = picked
      ? { ...picked, api: new ApiClient(picked.endpoint.url, this.actor().signer, this.fetchFn) }
      : null;
    if (this.conn?.serverId !== prev) this.changed();
    return this.conn;
  }

  // ---------- ローカルの記録 ----------

  private async putRecord(r: VerifiedRecord) {
    const rec: LocalRecord = { id: r.id, group: r.header.group, kind: r.header.kind, ts: r.header.ts, header: r.header, envelope: r.envelope };
    await this.db.put("records", rec);
  }

  async records(group: string): Promise<LocalRecord[]> {
    return this.db.getAllFromIndex("records", "group", group);
  }

  async state(group: string): Promise<GroupState> {
    return deriveGroupState(group, await this.records(group));
  }

  async key(group: string, epoch: string) {
    return (await this.db.get("keys", `${group}/${epoch}`)) ?? null;
  }

  /** 記録をローカルに保存し、送信キューに入れる */
  private async enqueue(group: string, records: VerifiedRecord[], blob?: { id: string; data: Uint8Array<ArrayBuffer> }) {
    if (blob) await this.db.put("blobs", { id: blob.id, data: blob.data, at: Date.now() });
    for (const [i, r] of records.entries()) {
      await this.putRecord(r);
      await this.db.add("outbox", {
        group,
        record: r.envelope,
        recordId: r.id,
        blob: i === 0 && blob ? { id: blob.id } : undefined,
        createdAt: Date.now(),
      });
    }
    this.changed();
  }

  // ---------- 同期 ----------

  /** 送信キューを流し、全グループを取得し、鍵の配布などの保守をする */
  sync(): Promise<void> {
    this.syncing ??= this.doSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async doSync() {
    if (!this.account) return;
    try {
      const conn = await this.connect();
      if (!conn) {
        this.lastError = "どのサーバーにも接続できません";
        this.changed();
        return;
      }
      await this.refreshAccount(conn);
      await this.adoptGroups(conn);
      await this.flush(conn);
      for (const g of await this.db.getAll("groups")) {
        await this.pull(conn, g.group);
        await this.maintain(g.group);
      }
      await this.flush(conn);
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      // 接続先が落ちた可能性があるので、次回は選び直す
      if (!(e instanceof ApiError)) this.conn = null;
    }
    this.changed();
  }

  private async flush(conn: Connection) {
    const items = await this.db.getAll("outbox");
    const blocked = new Set<string>();
    for (const item of items) {
      if (blocked.has(item.group)) continue;
      if (item.blob) {
        const b = await this.db.get("blobs", item.blob.id);
        if (b) await conn.api.uploadBlob(item.group, b.id, b.data);
      }
      const [res] = (await conn.api.postRecords(item.group, [item.record])).results;
      if (!res || res.status === "missing") {
        // 依存先がまだこのサーバーにない（例：招待がまだ同期されていない）。後で再送する
        blocked.add(item.group);
        continue;
      }
      if (res.status === "invalid") {
        console.warn("record rejected", item.recordId, res.reason);
        this.lastError = `送信できませんでした: ${res.reason}`;
        await this.db.delete("records", item.recordId);
      }
      await this.db.delete("outbox", item.seq!);
    }
  }

  private async pull(conn: Connection, group: string) {
    const ck = `${conn.serverId}/${group}`;
    let after = (await this.db.get("cursors", ck)) ?? 0;
    for (;;) {
      let page;
      try {
        page = await conn.api.getRecords(group, after);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 403)) throw e;
        // 参加手続き中ならそのまま待つ。そうでなければ（別の端末で）退会済み
        const g = await this.db.get("groups", group);
        if (g && !g.joining && !(await this.db.getAll("outbox")).some((o) => o.group === group)) await this.forget(group);
        return;
      }
      for (const env of page.records) {
        try {
          await this.putRecord(await openRecord(env));
        } catch (e) {
          console.warn("dropping invalid record", e);
        }
      }
      after = page.next;
      await this.db.put("cursors", after, ck);
      if (!page.more) break;
    }
    const g = await this.db.get("groups", group);
    if (g?.joining && (await this.state(group)).members.has(this.me!)) {
      await this.db.put("groups", { ...g, joining: false });
    }
  }

  /** 自分宛ての鍵の取り出し、退会後のローテーション、新メンバーへの鍵配布、プロフィールの公開 */
  private async maintain(group: string): Promise<void> {
    const me = this.me!;
    const actor = this.actor();
    const recs = await this.records(group);
    const s = await deriveGroupState(group, recs);

    for (const r of recs) {
      if (r.kind !== "key.wrap" || r.header.body?.to !== me) continue;
      const epoch = r.header.epoch!;
      if (await this.key(group, epoch)) continue;
      try {
        const k = await unwrapGroupKey(actor.kx, r.header.body as { enc: string; ct: string }, group, epoch);
        await this.db.put("keys", k, `${group}/${epoch}`);
      } catch (e) {
        console.warn("cannot unwrap", r.id, e);
      }
    }
    if (!s.members.has(me) || !s.currentEpoch) return;
    const now = Date.now();
    const isAdmin = s.admin === me;
    const byId = new Map(recs.map((r) => [r.id, r]));

    if (s.uncoveredLeaves.length > 0) {
      const oldest = Math.min(...s.uncoveredLeaves.map((id) => byId.get(id)?.ts ?? now));
      if (isAdmin || now - oldest > HELP_DELAY_MS) {
        const rot = await rotateKey(actor, s);
        await this.db.put("keys", rot.key, `${group}/${rot.epoch}`);
        await this.enqueue(group, rot.records);
        return this.maintain(group);
      }
    }

    const key = await this.key(group, s.currentEpoch);
    if (!key) return;
    const wrapped = new Set(
      recs.filter((r) => r.kind === "key.wrap" && r.header.epoch === s.currentEpoch).map((r) => r.header.body!.to as string),
    );
    for (const m of s.members.values()) {
      if (wrapped.has(m.pk)) continue;
      const since = byId.get(m.since)?.ts ?? now;
      if (isAdmin || now - since > HELP_DELAY_MS) await this.enqueue(group, [await wrapFor(actor, group, s.currentEpoch, key, m)]);
    }

    // 新しい epoch では古い鍵を持たない人がいるので、プロフィールと（管理者は）グループ設定を出し直す
    const hasMine = (kind: string) =>
      recs.some((r) => r.kind === kind && r.header.author === me && r.header.epoch === s.currentEpoch);
    if (!hasMine("profile") || !(await this.db.get("meta", `profile/${group}`))) {
      await this.enqueue(group, [await setProfile(actor, s, key, this.profile())]);
      await this.db.put("meta", true, `profile/${group}`);
    }
    if (isAdmin && s.settings.recordId && byId.get(s.settings.recordId)?.header.epoch !== s.currentEpoch) {
      const meta = await this.groupMeta(group, s);
      if (meta) await this.enqueue(group, [await updateSettings(actor, s, key, meta)]);
    }
  }

  // ---------- 操作 ----------

  async createGroup(name: string) {
    const actor = this.actor();
    const g = await createGroup(actor, { name });
    await this.db.put("keys", g.key, `${g.group}/${g.epoch}`);
    await this.db.put("groups", { group: g.group, addedAt: Date.now() });
    const s = await deriveGroupState(g.group, g.records);
    const profile = await setProfile(actor, s, g.key, this.profile());
    await this.db.put("meta", true, `profile/${g.group}`);
    await this.enqueue(g.group, [...g.records, profile]);
    void this.sync();
    return g.group;
  }

  async createInviteLink(group: string, origin: string) {
    const s = await this.state(group);
    const { record, token } = await createInvite(this.actor(), s);
    await this.enqueue(group, [record]);
    await this.sync();
    const params = new URLSearchParams({ g: group, i: record.id, t: token });
    return `${origin}/#/join?${params}`;
  }

  async revokeInvite(group: string, invite: string) {
    await this.enqueue(group, [await revokeInvite(this.actor(), await this.state(group), invite)]);
    void this.sync();
  }

  async join(group: string, invite: string, token: string) {
    // 同じリンクを何度開いても、参加レコードは 1 回だけ作る
    if (await this.db.get("groups", group)) return void this.sync();
    await this.db.put("groups", { group, addedAt: Date.now(), joining: true });
    await this.enqueue(group, [await joinGroup(this.actor(), group, invite, token)]);
    await this.sync();
  }

  async leave(group: string, successor?: string) {
    const rec = await leaveGroup(this.actor(), await this.state(group), successor);
    await this.enqueue(group, [rec]);
    await this.sync();
    const pending = (await this.db.getAll("outbox")).some((o) => o.recordId === rec.id);
    if (!pending) await this.forget(group);
    return !pending;
  }

  /** グループのローカルデータを消す */
  async forget(group: string) {
    const tx = this.db.transaction(["records", "groups", "keys"], "readwrite");
    for (const r of await tx.objectStore("records").index("group").getAllKeys(group)) await tx.objectStore("records").delete(r);
    for (const k of await tx.objectStore("keys").getAllKeys(IDBKeyRange.bound(`${group}/`, `${group}/￿`))) await tx.objectStore("keys").delete(k);
    await tx.objectStore("groups").delete(group);
    await tx.done;
    this.changed();
  }

  async transferAdmin(group: string, to: string) {
    await this.enqueue(group, [await transferAdmin(this.actor(), await this.state(group), to)]);
    await this.sync();
  }

  async updateGroupSettings(group: string, meta: GroupMeta, pub: { hours?: [number, number]; editableBy?: "admin" | "members" } = {}) {
    const s = await this.state(group);
    const key = await this.key(group, s.currentEpoch!);
    if (!key) throw new Error("グループ鍵がまだありません");
    await this.enqueue(group, [await updateSettings(this.actor(), s, key, meta, pub.hours ? { ...pub, utcOffsetMin: -new Date().getTimezoneOffset() } : pub)]);
    void this.sync();
  }

  /** 撮影した動画を、選んだ各グループ向けに別々に暗号化して投稿する */
  async post(groups: string[], video: Uint8Array<ArrayBuffer>, mime: string, durationMs: number, takenAt: number, text?: string, size?: { w: number; h: number }) {
    const actor = this.actor();
    const t = text?.trim() || undefined;
    for (const group of groups) {
      const s = await this.state(group);
      const key = s.currentEpoch ? await this.key(group, s.currentEpoch) : null;
      if (!key) throw new Error("グループ鍵がまだありません");
      const blob = await encryptBlob(video);
      const rec = await createPost(actor, s, key, blob.blobId, { ck: blob.ck, mime, durationMs, takenAt, ...(t ? { text: t } : {}), ...(size ?? {}) });
      await this.enqueue(group, [rec], { id: blob.blobId, data: blob.sealed });
    }
    void this.sync();
  }

  private async currentKey(group: string) {
    const s = await this.state(group);
    const key = s.currentEpoch ? await this.key(group, s.currentEpoch) : null;
    if (!key) throw new Error("グループ鍵がまだありません");
    return { s, key };
  }

  private lastReactionTs = 0;

  /** リアクション。同じ絵文字をもう一度押すと取り消す */
  async react(post: PostView, emoji: string) {
    const { s, key } = await this.currentKey(post.group);
    const mine = post.reactions.find((r) => r.mine)?.emoji;
    const ref = { id: post.id, author: post.author, exp: post.exp };
    // 同じミリ秒に続けて押すと ts が並び、どちらが有効かが ID 次第になるので単調に増やす
    const ts = Math.max(Date.now(), this.lastReactionTs + 1);
    this.lastReactionTs = ts;
    await this.enqueue(post.group, [await createReaction(this.actor(), s, key, ref, mine === emoji ? "" : emoji, ts)]);
    void this.sync();
  }

  async reply(post: PostView, text: string) {
    const { s, key } = await this.currentKey(post.group);
    const ref = { id: post.id, author: post.author, exp: post.exp };
    await this.enqueue(post.group, [await createReply(this.actor(), s, key, ref, text.trim())]);
    void this.sync();
  }

  /** 自分の投稿の文字を変える。空にすると文字を消す */
  async editText(post: PostView, text: string) {
    const { s, key } = await this.currentKey(post.group);
    const ref = { id: post.id, author: post.author, exp: post.exp };
    await this.enqueue(post.group, [await editPost(this.actor(), s, key, ref, text.trim())]);
    void this.sync();
  }

  /** 自分の投稿を消す。まだ送っていなければ、送らずにこの端末から消すだけ */
  async deletePost(post: PostView) {
    const queued = (await this.db.getAll("outbox")).find((o) => o.recordId === post.id);
    if (queued) {
      await this.db.delete("outbox", queued.seq!);
      await this.db.delete("records", post.id);
    } else {
      const s = await this.state(post.group);
      await this.enqueue(post.group, [await deletePost(this.actor(), s, { id: post.id, author: post.author, exp: post.exp })]);
    }
    await this.db.delete("blobs", post.blobId);
    this.changed();
    void this.sync();
  }

  // ---------- 表示用 ----------

  /** レコードの暗号文を開く。鍵がない・壊れているときは null */
  private async open<T>(group: string, r: LocalRecord): Promise<T | null> {
    if (this.plain.has(r.id)) return this.plain.get(r.id) as T;
    const key = await this.key(group, r.header.epoch!);
    if (!key) return null;
    try {
      const v = await openContent<T>(key, r.header);
      this.plain.set(r.id, v);
      return v;
    } catch {
      return null;
    }
  }

  async groupMeta(group: string, s?: GroupState): Promise<GroupMeta | null> {
    s ??= await this.state(group);
    if (!s.settings.recordId) return null;
    const r = await this.db.get("records", s.settings.recordId);
    return r ? this.open<GroupMeta>(group, r) : null;
  }

  private async profiles(group: string, recs: LocalRecord[]) {
    const names = new Map<string, { name: string; icon?: string; ts: number }>();
    for (const r of recs) {
      if (r.kind !== "profile") continue;
      const p = await this.open<Profile>(group, r);
      if (!p) continue;
      const cur = names.get(r.header.author);
      if (!cur || cur.ts < r.ts) names.set(r.header.author, { name: p.name, icon: p.icon, ts: r.ts });
    }
    for (const [pk, p] of names) this.rememberIcon(pk, p.icon);
    return names;
  }

  async groups(): Promise<GroupView[]> {
    const out: GroupView[] = [];
    for (const g of await this.db.getAll("groups")) out.push(await this.groupView(g.group));
    return out.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }

  async groupView(group: string): Promise<GroupView> {
    const me = this.me;
    const local = await this.db.get("groups", group);
    const recs = await this.records(group);
    const s = await deriveGroupState(group, recs);
    const names = await this.profiles(group, recs);
    const meta = await this.groupMeta(group, s);
    this.rememberIcon(group, meta?.icon);
    const isMember = !!me && s.members.has(me);
    return {
      group,
      name: meta?.name ?? null,
      icon: meta?.icon && isIcon(meta.icon) ? meta.icon : undefined,
      canEdit: isMember && (s.admin === me || s.settings.editableBy === "members"),
      joining: local?.joining ?? false,
      state: s,
      isMember,
      isAdmin: s.admin === me,
      hasKey: !!s.currentEpoch && !!(await this.key(group, s.currentEpoch)),
      members: [...s.members.values()].map((m) => ({
        pk: m.pk,
        name: names.get(m.pk)?.name ?? null,
        isAdmin: s.admin === m.pk,
        isMe: m.pk === me,
      })),
      invites: [...s.invites.entries()]
        .filter(([, i]) => !i.revoked && (i.exp === undefined || i.exp > Date.now()))
        .map(([id, i]) => ({ id, exp: i.exp, mine: i.author === me })),
    };
  }

  async posts(group: string): Promise<PostView[]> {
    const now = Date.now();
    const recs = (await this.records(group)).filter((r) => (r.header.exp ?? Infinity) >= now);
    const names = await this.profiles(group, recs);
    const pending = new Set((await this.db.getAll("outbox")).map((o) => o.recordId));

    // リアクションは作成者ごと・投稿ごとに最新の 1 つ。返信は全部
    const reactions = new Map<string, Map<string, { emoji: string; ts: number; id: string }>>();
    const replies = new Map<string, PostView["replies"]>();
    // 文字の変更と削除は、投稿者本人のものだけを後で当てる
    const edits = new Map<string, { author: string; text: string; ts: number; id: string }>();
    const deleted = new Map<string, string>();
    for (const r of recs) {
      if (r.kind === "post.delete") {
        deleted.set(r.header.body!.post as string, r.header.author);
      } else if (r.kind === "post.edit") {
        const c = await this.open<PostEditContent>(group, r);
        if (!c) continue;
        const key = `${c.ref}/${r.header.author}`;
        const cur = edits.get(key);
        if (!cur || cur.ts < r.ts || (cur.ts === r.ts && cur.id < r.id)) edits.set(key, { author: r.header.author, text: c.text, ts: r.ts, id: r.id });
      } else if (r.kind === "reaction") {
        const c = await this.open<ReactionContent>(group, r);
        if (!c) continue;
        const per = reactions.get(c.ref) ?? reactions.set(c.ref, new Map()).get(c.ref)!;
        const cur = per.get(r.header.author);
        if (!cur || cur.ts < r.ts || (cur.ts === r.ts && cur.id < r.id)) per.set(r.header.author, { emoji: c.emoji, ts: r.ts, id: r.id });
      } else if (r.kind === "reply") {
        const c = await this.open<ReplyContent>(group, r);
        if (!c) continue;
        (replies.get(c.ref) ?? replies.set(c.ref, []).get(c.ref)!).push({
          id: r.id,
          author: r.header.author,
          authorName: names.get(r.header.author)?.name ?? null,
          text: c.text,
          ts: r.ts,
        });
      }
    }

    const out: PostView[] = [];
    for (const r of recs) {
      if (r.kind !== "post" || deleted.get(r.id) === r.header.author) continue;
      const opened = await this.open<PostContent>(group, r);
      const edit = edits.get(`${r.id}/${r.header.author}`);
      const content = opened && edit ? { ...opened, text: edit.text || undefined } : opened;
      const counts = new Map<string, { count: number; mine: boolean }>();
      for (const [author, x] of reactions.get(r.id) ?? []) {
        if (!x.emoji) continue;
        const c = counts.get(x.emoji) ?? { count: 0, mine: false };
        counts.set(x.emoji, { count: c.count + 1, mine: c.mine || author === this.me });
      }
      out.push({
        id: r.id,
        group,
        author: r.header.author,
        authorName: names.get(r.header.author)?.name ?? null,
        ts: content?.takenAt ?? r.ts,
        exp: r.header.exp!,
        blobId: r.header.blobs![0]!,
        content,
        pending: pending.has(r.id),
        reactions: [...counts].map(([emoji, c]) => ({ emoji, ...c })).sort((x, y) => y.count - x.count),
        replies: (replies.get(r.id) ?? []).sort((x, y) => x.ts - y.ts),
      });
    }
    return out.sort((a, b) => b.ts - a.ts);
  }

  /** 動画を取得・復号する。暗号文はローカルにキャッシュする */
  async video(post: PostView): Promise<Blob> {
    if (!post.content) throw new Error("この投稿を読む鍵がありません");
    let cached = await this.db.get("blobs", post.blobId);
    if (!cached) {
      const conn = await this.connect();
      if (!conn) throw new Error("サーバーに接続できません");
      const data = await conn.api.downloadBlob(post.blobId);
      cached = { id: post.blobId, data, at: Date.now() };
      await this.db.put("blobs", cached);
    }
    const plain = await decryptBlob(post.content.ck, cached.data, post.blobId);
    return new Blob([plain], { type: post.content.mime });
  }

  /** 期限切れの投稿と動画キャッシュを消す */
  async prune() {
    const now = Date.now();
    const tx = this.db.transaction(["records", "blobs"], "readwrite");
    for (const r of await tx.objectStore("records").getAll()) {
      if (r.header.exp !== undefined && r.header.exp < now) await tx.objectStore("records").delete(r.id);
    }
    for (const b of await tx.objectStore("blobs").getAll()) {
      if (now - b.at > 8 * 24 * 60 * 60 * 1000) await tx.objectStore("blobs").delete(b.id);
    }
    await tx.done;
  }

  /** この 1 時間にすでに投稿したか（setlog と同じく 1 時間に 1 本） */
  async postedThisHour(group: string) {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    const recs = await this.records(group);
    const deleted = new Set(recs.filter((r) => r.kind === "post.delete" && r.header.author === this.me).map((r) => r.header.body!.post as string));
    return recs.some((r) => r.kind === "post" && r.header.author === this.me && r.ts >= start.getTime() && !deleted.has(r.id));
  }
}

