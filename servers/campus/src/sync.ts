import { ApiClient, ApiError, type Envelope, type Signer, fromB64u, utf8 } from "@knct-log/core";
import { type Deps, type Store, upsertAccount } from "@knct-log/server-app";

const BATCH = 100;
const PULL_CURSOR = "sync.pull.records";
const SUBS_PULL = "sync.pull.subs";
const SUBS_PUSH = "sync.push.subs";
const SLOTS_PULL = "sync.pull.slots";
const SLOTS_PUSH = "sync.push.slots";
const ACC_PULL = "sync.pull.accounts";
const ACC_PUSH = "sync.push.accounts";
const PEER_INSTANCE = "sync.peer_instance";
export const LAST_OK = "sync.last_ok";

/**
 * 学内 → CF の双方向同期。学内からの外向き通信だけで完結する。
 * レコードは内容アドレスで不変なので、何度繰り返しても結果は同じ（冪等）。
 */
export class SyncWorker {
  readonly peer: ApiClient;
  private readonly deps: Deps;
  private readonly store: Store;
  private running = false;

  constructor(peerUrl: string, signer: Signer, deps: Deps, store: Store, fetchFn?: typeof fetch) {
    this.peer = new ApiClient(peerUrl, signer, fetchFn);
    this.deps = deps;
    this.store = store;
  }

  /** 1 周期ぶんの同期。失敗しても次の周期で続きから再開できる。 */
  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      await this.checkPeerInstance();
      const pulled = await this.pullRecords();
      const pushed = await this.pushRecords();
      const blobs = await this.fetchMissingBlobs();
      await this.syncSubs();
      await this.syncSlots();
      await this.syncAccounts();
      await this.store.kvSet(LAST_OK, String(this.store.now()));
      return { pulled, pushed, blobs };
    } finally {
      this.running = false;
    }
  }

  /**
   * ピアの DB が作り直されていたら（instance が変わったら）、カーソルを捨てて
   * 手元の全レコードを送り直す。古いカーソルのままだと新しいデータを取りこぼすため。
   */
  private async checkPeerInstance() {
    const { instance } = await this.peer.health();
    if (!instance) return;
    const known = await this.store.kvGet(PEER_INSTANCE);
    if (known === instance) return;
    if (known !== null) {
      console.warn(`sync: peer database changed (${known} -> ${instance}); resyncing everything`);
      await this.deps.sql.batch([
        ...[PULL_CURSOR, SUBS_PULL, SUBS_PUSH, SLOTS_PULL, SLOTS_PUSH, ACC_PULL, ACC_PUSH].map((k) => ({ sql: "DELETE FROM kv WHERE k = ?", params: [k] })),
        { sql: "UPDATE records SET pushed = 0", params: [] },
      ]);
    }
    await this.store.kvSet(PEER_INSTANCE, instance);
  }

  private async cursor(k: string) {
    return Number((await this.store.kvGet(k)) ?? 0);
  }

  private async pullRecords() {
    let after = await this.cursor(PULL_CURSOR);
    let total = 0;
    for (;;) {
      const page = await this.peer.peerRecords(after, BATCH);
      if (page.records.length === 0) break;
      const results = await this.store.ingestPeer(page.records);
      const stuck = results.findIndex((r) => r.status === "missing");
      if (stuck >= 0) {
        // 欠けている依存先が届くまで、そこから先には進まない
        console.warn("sync: pulled record has missing deps", results[stuck]);
        break;
      }
      total += results.filter((r) => r.status === "ok").length;
      after = page.next;
      await this.store.kvSet(PULL_CURSOR, String(after));
      if (!page.more) break;
    }
    return total;
  }

  private async pushRecords() {
    let total = 0;
    for (;;) {
      const rows = await this.deps.sql.all<{ seq: number; id: string; grp: string; kind: string; payload: string; sig: string }>(
        "SELECT seq, id, grp, kind, payload, sig FROM records WHERE pushed = 0 ORDER BY seq LIMIT ?",
        BATCH,
      );
      if (rows.length === 0) break;
      for (const r of rows.filter((r) => r.kind === "post")) await this.pushBlobsOf(r.grp, r.payload);
      const { results } = await this.peer.peerPostRecords(rows.map((r): Envelope => ({ payload: r.payload, sig: r.sig })));
      const done: string[] = [];
      for (const [i, res] of results.entries()) {
        if (res.status === "missing") break;
        if (res.status === "invalid") console.warn("sync: peer rejected record", rows[i]!.id, res.reason);
        done.push(rows[i]!.id);
      }
      if (done.length) {
        await this.deps.sql.batch(done.map((id) => ({ sql: "UPDATE records SET pushed = 1 WHERE id = ?", params: [id] })));
      }
      total += done.length;
      if (done.length < rows.length) break;
    }
    return total;
  }

  private async pushBlobsOf(grp: string, payload: string) {
    const blobs = (JSON.parse(utf8.decode(fromB64u(payload))) as { blobs?: string[] }).blobs ?? [];
    for (const id of blobs) {
      const stream = await this.deps.blobs.get(id);
      if (!stream) continue;
      const data = new Uint8Array(await new Response(stream).arrayBuffer());
      await this.peer.uploadBlob(grp, id, data);
    }
  }

  private async fetchMissingBlobs() {
    const rows = await this.deps.sql.all<{ id: string }>(
      "SELECT id FROM blobs WHERE stored = 0 AND exp > ? ORDER BY created_at LIMIT 20",
      this.store.now(),
    );
    let n = 0;
    for (const { id } of rows) {
      try {
        const data = await this.peer.downloadBlob(id);
        await this.deps.blobs.put(id, data);
        await this.deps.sql.run("UPDATE blobs SET stored = 1, size = ? WHERE id = ?", data.length, id);
        n++;
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
    }
    return n;
  }

  private async syncSubs() {
    type Sub = { endpoint: string; pk: string; p256dh: string; auth: string; deleted: number; updated_at: number };
    const pullSince = await this.cursor(SUBS_PULL);
    const { subs } = await this.peer.peerGet<{ subs: Sub[] }>(`push-subs?since=${pullSince}`);
    if (subs.length) {
      await this.deps.sql.batch(
        subs.map((r) => ({
          sql: `INSERT INTO push_subs (endpoint, pk, p256dh, auth, deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (endpoint) DO UPDATE SET pk = excluded.pk, p256dh = excluded.p256dh, auth = excluded.auth,
                  deleted = excluded.deleted, updated_at = excluded.updated_at
                WHERE excluded.updated_at > push_subs.updated_at`,
          params: [r.endpoint, r.pk, r.p256dh, r.auth, r.deleted, r.updated_at],
        })),
      );
      await this.store.kvSet(SUBS_PULL, String(subs.at(-1)!.updated_at));
    }
    const pushSince = await this.cursor(SUBS_PUSH);
    const local = await this.deps.sql.all<Sub>(
      "SELECT endpoint, pk, p256dh, auth, deleted, updated_at FROM push_subs WHERE updated_at > ? ORDER BY updated_at LIMIT 500",
      pushSince,
    );
    if (local.length) {
      await this.peer.peerPost("push-subs", { subs: local });
      await this.store.kvSet(SUBS_PUSH, String(local.at(-1)!.updated_at));
    }
  }

  /** アカウント文書。ts の新しい方を採用する（署名はそれぞれのサーバーで検証） */
  private async syncAccounts() {
    type Acc = { payload: string; sig: string; updated_at: number };
    for (;;) {
      const since = await this.cursor(ACC_PULL);
      const { accounts } = await this.peer.peerGet<{ accounts: Acc[] }>(`accounts?since=${since}`);
      if (accounts.length === 0) break;
      for (const a of accounts) await upsertAccount(this.store, { payload: a.payload, sig: a.sig });
      await this.store.kvSet(ACC_PULL, String(accounts.at(-1)!.updated_at));
    }
    for (;;) {
      const since = await this.cursor(ACC_PUSH);
      const local = await this.deps.sql.all<Acc>(
        "SELECT payload, sig, updated_at FROM accounts WHERE updated_at > ? ORDER BY updated_at LIMIT 200",
        since,
      );
      if (local.length === 0) break;
      await this.peer.peerPost("accounts", { accounts: local.map((a) => ({ payload: a.payload, sig: a.sig })) });
      await this.store.kvSet(ACC_PUSH, String(local.at(-1)!.updated_at));
    }
  }

  private async syncSlots() {
    type Slot = { slot: string; sent_by: string; sent_at: number };
    const pullSince = await this.cursor(SLOTS_PULL);
    const { slots } = await this.peer.peerGet<{ slots: Slot[] }>(`push-slots?since=${pullSince}`);
    if (slots.length) {
      await this.deps.sql.batch(
        slots.map((s) => ({
          sql: "INSERT INTO push_slots (slot, sent_by, sent_at) VALUES (?, ?, ?) ON CONFLICT (slot) DO NOTHING",
          params: [s.slot, s.sent_by, s.sent_at],
        })),
      );
      await this.store.kvSet(SLOTS_PULL, String(slots.at(-1)!.sent_at));
    }
    const pushSince = await this.cursor(SLOTS_PUSH);
    const local = await this.deps.sql.all<Slot>(
      "SELECT slot, sent_by, sent_at FROM push_slots WHERE sent_at > ? ORDER BY sent_at LIMIT 500",
      pushSince,
    );
    if (local.length) {
      await this.peer.peerPost("push-slots", { slots: local });
      await this.store.kvSet(SLOTS_PUSH, String(local.at(-1)!.sent_at));
    }
  }
}
