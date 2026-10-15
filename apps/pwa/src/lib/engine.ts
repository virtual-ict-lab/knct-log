import {
  type Actor,
  ApiClient,
  ApiError,
  type GroupMeta,
  type GroupState,
  type PostContent,
  type Profile,
  type VerifiedRecord,
  createGroup,
  createInvite,
  createPost,
  cryptoKeySigner,
  decryptBlob,
  deriveGroupState,
  encryptBlob,
  generateDeviceKeys,
  joinGroup,
  leaveGroup,
  openContent,
  openRecord,
  revokeInvite,
  rotateKey,

  setProfile,
  transferAdmin,
  unwrapGroupKey,
  updateSettings,
  wrapFor,
} from "@knct-log/core";
import type { DB, Endpoint, LocalRecord, StoredDevice } from "./db.ts";
import { pickEndpoint } from "./endpoints.ts";

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
  blobId: string;
  content: PostContent | null;
  pending: boolean;
}

type Picker = (endpoints: Endpoint[]) => Promise<{ endpoint: Endpoint; serverId: string } | null>;

export class Engine extends EventTarget {
  readonly db: DB;
  private readonly fetchFn?: typeof fetch;
  private readonly picker: Picker;
  device: StoredDevice | null = null;
  conn: Connection | null = null;
  lastError: string | null = null;
  private syncing: Promise<void> | null = null;

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
    return this.device?.signPub ?? null;
  }

  private actor(): Actor & { kx: CryptoKeyPair } {
    const d = this.device!;
    return { signer: cryptoKeySigner(d.signPub, d.sign.privateKey), kxPub: d.kxPub, kx: d.kx };
  }

  // ---------- 端末 ----------

  async load() {
    this.device = ((await this.db.get("meta", "device")) as StoredDevice | undefined) ?? null;
    this.changed();
  }

  async setupDevice(name: string) {
    const k = await generateDeviceKeys();
    const device: StoredDevice = { ...k, name, createdAt: Date.now() };
    await this.db.put("meta", device, "device");
    this.device = device;
    this.changed();
  }

  async rename(name: string) {
    this.device = { ...this.device!, name };
    await this.db.put("meta", this.device, "device");
    // 各グループのプロフィールは次の maintain で出し直す
    for (const g of await this.db.getAll("groups")) await this.db.delete("meta", `profile/${g.group}`);
    this.changed();
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
    if (!this.device) return;
    try {
      const conn = await this.connect();
      if (!conn) {
        this.lastError = "どのサーバーにも接続できません";
        this.changed();
        return;
      }
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
        if (e instanceof ApiError && e.status === 403) return; // 参加手続き中、または退会済み
        throw e;
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
      await this.enqueue(group, [await setProfile(actor, s, key, { name: this.device!.name })]);
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
    const profile = await setProfile(actor, s, g.key, { name: this.device!.name });
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

  async updateGroupSettings(group: string, meta: GroupMeta, pub: { hours?: [number, number] }) {
    const s = await this.state(group);
    const key = await this.key(group, s.currentEpoch!);
    if (!key) throw new Error("グループ鍵がまだありません");
    await this.enqueue(group, [await updateSettings(this.actor(), s, key, meta, { ...pub, utcOffsetMin: -new Date().getTimezoneOffset() })]);
    void this.sync();
  }

  /** 撮影した動画を、選んだ各グループ向けに別々に暗号化して投稿する */
  async post(groups: string[], video: Uint8Array<ArrayBuffer>, mime: string, durationMs: number, takenAt: number) {
    const actor = this.actor();
    for (const group of groups) {
      const s = await this.state(group);
      const key = s.currentEpoch ? await this.key(group, s.currentEpoch) : null;
      if (!key) throw new Error("グループ鍵がまだありません");
      const blob = await encryptBlob(video);
      const rec = await createPost(actor, s, key, blob.blobId, { ck: blob.ck, mime, durationMs, takenAt });
      await this.enqueue(group, [rec], { id: blob.blobId, data: blob.sealed });
    }
    void this.sync();
  }

  // ---------- 表示用 ----------

  async groupMeta(group: string, s?: GroupState): Promise<GroupMeta | null> {
    s ??= await this.state(group);
    if (!s.settings.recordId) return null;
    const r = await this.db.get("records", s.settings.recordId);
    const key = r ? await this.key(group, r.header.epoch!) : null;
    if (!r || !key) return null;
    try {
      return await openContent<GroupMeta>(key, r.header);
    } catch {
      return null;
    }
  }

  private async profiles(group: string, recs: LocalRecord[]) {
    const names = new Map<string, { name: string; ts: number }>();
    for (const r of recs) {
      if (r.kind !== "profile") continue;
      const key = await this.key(group, r.header.epoch!);
      if (!key) continue;
      try {
        const p = await openContent<Profile>(key, r.header);
        const cur = names.get(r.header.author);
        if (!cur || cur.ts < r.ts) names.set(r.header.author, { name: p.name, ts: r.ts });
      } catch {
        // 読めないプロフィールは無視
      }
    }
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
    return {
      group,
      name: (await this.groupMeta(group, s))?.name ?? null,
      joining: local?.joining ?? false,
      state: s,
      isMember: !!me && s.members.has(me),
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
    const recs = await this.records(group);
    const names = await this.profiles(group, recs);
    const pending = new Set((await this.db.getAll("outbox")).map((o) => o.recordId));
    const out: PostView[] = [];
    for (const r of recs) {
      if (r.kind !== "post" || (r.header.exp ?? 0) < Date.now()) continue;
      const key = await this.key(group, r.header.epoch!);
      let content: PostContent | null = null;
      if (key) {
        try {
          content = await openContent<PostContent>(key, r.header);
        } catch {
          content = null;
        }
      }
      out.push({
        id: r.id,
        group,
        author: r.header.author,
        authorName: names.get(r.header.author)?.name ?? null,
        ts: content?.takenAt ?? r.ts,
        blobId: r.header.blobs![0]!,
        content,
        pending: pending.has(r.id),
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
    return (await this.records(group)).some((r) => r.kind === "post" && r.header.author === this.me && r.ts >= start.getTime());
  }
}

