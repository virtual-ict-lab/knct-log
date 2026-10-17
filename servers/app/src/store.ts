import {
  CONTROL_KINDS,
  type Envelope,
  type GroupState,
  type Header,
  type IngestResult,
  POST_TTL_MS,
  admitContent,
  admitControl,
  deriveGroupState,
  fromB64u,
  isControlKind,
  openRecord,
  utf8,
} from "@knct-log/core";
import type { Deps } from "./deps.ts";


interface Ctl {
  id: string;
  header: Header;
}

/** 未着の blob は missing に `blob:<id>` として返す */
export const BLOB_PREFIX = "blob:";
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
export const BLOB_GRACE_MS = 24 * 60 * 60 * 1000;
const CONTROL_IN = `(${CONTROL_KINDS.map((k) => `'${k}'`).join(",")})`;

function header(payload: string): Header {
  return JSON.parse(utf8.decode(fromB64u(payload))) as Header;
}

export class Store {
  private readonly d: Deps;
  constructor(d: Deps) {
    this.d = d;
  }

  now() {
    return this.d.now?.() ?? Date.now();
  }

  get sql() {
    return this.d.sql;
  }

  async controlRecords(grp: string): Promise<Ctl[]> {
    const rows = await this.d.sql.all<{ id: string; payload: string }>(
      `SELECT id, payload FROM records WHERE grp = ? AND kind IN ${CONTROL_IN} ORDER BY seq`,
      grp,
    );
    return rows.map((r) => ({ id: r.id, header: header(r.payload) }));
  }

  async isMember(grp: string, pk: string) {
    return (await this.d.sql.first("SELECT 1 AS x FROM members WHERE grp = ? AND pk = ?", grp, pk)) !== null;
  }

  async existing(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.d.sql.all<{ id: string }>(
      `SELECT id FROM records WHERE id IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    );
    return new Set(rows.map((r) => r.id));
  }

  async storedBlobs(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.d.sql.all<{ id: string; stored: number }>(
      `SELECT id, stored FROM blobs WHERE id IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    );
    const stored = new Set(rows.filter((r) => r.stored === 1).map((r) => r.id));
    // presigned アップロードの場合は、実体を確認してから stored にする
    if (this.d.blobs.head) {
      for (const r of rows.filter((r) => r.stored === 0)) {
        const size = await this.d.blobs.head(r.id);
        if (size === null) continue;
        await this.d.sql.run("UPDATE blobs SET stored = 1, size = ? WHERE id = ?", size, r.id);
        stored.add(r.id);
      }
    }
    return stored;
  }

  /** 制御レコードから groups / members キャッシュを作り直す */
  async refreshGroup(grp: string): Promise<GroupState> {
    const s = await deriveGroupState(grp, await this.controlRecords(grp));
    if (!s.createId) return s;
    const stmts = [
      { sql: "DELETE FROM members WHERE grp = ?", params: [grp] },
      ...[...s.members.keys()].map((pk) => ({ sql: "INSERT INTO members (grp, pk) VALUES (?, ?)", params: [grp, pk] })),
      {
        sql: `INSERT INTO groups (grp, admin, dissolved, hours_start, hours_end, utc_offset_min, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (grp) DO UPDATE SET admin = excluded.admin, dissolved = excluded.dissolved,
                hours_start = excluded.hours_start, hours_end = excluded.hours_end,
                utc_offset_min = excluded.utc_offset_min, updated_at = excluded.updated_at`,
        params: [grp, s.admin, s.dissolved ? 1 : 0, s.settings.hours[0], s.settings.hours[1], s.settings.utcOffsetMin, this.now()],
      },
    ];
    await this.d.sql.batch(stmts);
    return s;
  }

  private async insert(id: string, h: Header, env: Envelope, origin: "direct" | "peer") {
    const r = await this.d.sql.run(
      `INSERT INTO records (id, grp, kind, author, ts, exp, payload, sig, origin, pushed, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      id, h.group, h.kind, h.author, h.ts, h.exp ?? null, env.payload, env.sig, origin, origin === "peer" ? 1 : 0, this.now(),
    );
    return r.changes > 0;
  }

  private async attachBlobs(h: Header) {
    if (h.kind !== "post" || !h.blobs) return;
    const exp = h.exp! + BLOB_GRACE_MS;
    await this.d.sql.batch(
      h.blobs.map((b) => ({
        sql: `INSERT INTO blobs (id, grp, size, exp, stored, created_at) VALUES (?, ?, 0, ?, 0, ?)
              ON CONFLICT (id) DO UPDATE SET exp = max(blobs.exp, excluded.exp)`,
        params: [b, h.group, exp, this.now()],
      })),
    );
  }

  /** 削除の対象。同じグループ・同じ作成者の post のときだけ返す */
  private async deleteTarget(h: Header): Promise<Header | null> {
    const row = await this.d.sql.first<{ payload: string }>("SELECT payload FROM records WHERE id = ?", h.body!.post as string);
    if (!row) return null;
    const post = header(row.payload);
    return post.kind === "post" && post.group === h.group && post.author === h.author ? post : null;
  }

  /** 削除された投稿の動画を消す。投稿のレコードは削除のレコードと一緒に期限まで残す */
  private async dropBlobsOf(post: Header) {
    const ids = post.blobs ?? [];
    if (!ids.length) return;
    await this.d.blobs.delete(ids);
    await this.d.sql.batch(ids.map((id) => ({ sql: "DELETE FROM blobs WHERE id = ?", params: [id] })));
  }

  /**
   * クライアントから直接届いたレコードを検証して保存する。
   * 作成者が認証済み端末であること、メンバー規則、blob の到着をすべて確認する。
   */
  async ingestDirect(grp: string, pk: string, envelopes: unknown[], onAccepted?: (h: Header, id: string) => void) {
    const results: IngestResult[] = [];
    let ctl: Ctl[] | null = null;
    let state: GroupState | null = null;
    for (const env of envelopes) {
      let rec;
      try {
        rec = await openRecord(env);
      } catch (e) {
        results.push({ id: null, status: "invalid", reason: (e as Error).message });
        continue;
      }
      const { id, header: h } = rec;
      const invalid = (reason: string) => results.push({ id, status: "invalid", reason });
      if (h.group !== grp) { invalid("group mismatch"); continue; }
      if (h.author !== pk) { invalid("author must be the authenticated device"); continue; }
      if (h.ts > this.now() + MAX_CLOCK_SKEW_MS) { invalid("timestamp in the future"); continue; }
      if (h.exp !== undefined && h.exp <= this.now()) { invalid("already expired"); continue; }
      if ((await this.existing([id])).size > 0) { results.push({ id, status: "dup" }); continue; }

      ctl ??= await this.controlRecords(grp);
      if (isControlKind(h.kind)) {
        const adm = await admitControl(grp, ctl, rec);
        if (!adm.ok) {
          results.push("reason" in adm ? { id, status: "invalid", reason: adm.reason } : { id, status: "missing", missing: adm.missing });
          continue;
        }
        await this.insert(id, h, rec.envelope, "direct");
        ctl.push(rec);
        state = await this.refreshGroup(grp);
      } else {
        state ??= await deriveGroupState(grp, ctl);
        const adm = admitContent(state, h);
        if (!adm.ok) {
          results.push("reason" in adm ? { id, status: "invalid", reason: adm.reason } : { id, status: "missing", missing: adm.missing });
          continue;
        }
        const have = await this.existing(h.deps);
        const missDeps = h.deps.filter((d) => !have.has(d));
        if (missDeps.length) { results.push({ id, status: "missing", missing: missDeps }); continue; }
        if (h.exp !== undefined && h.exp > h.ts + POST_TTL_MS + MAX_CLOCK_SKEW_MS) { invalid("exp too far"); continue; }
        if (h.kind === "post") {
          const stored = await this.storedBlobs(h.blobs!);
          const miss = h.blobs!.filter((b) => !stored.has(b));
          if (miss.length) { results.push({ id, status: "missing", missing: miss.map((b) => BLOB_PREFIX + b) }); continue; }
        }
        const target = h.kind === "post.delete" ? await this.deleteTarget(h) : null;
        if (h.kind === "post.delete" && !target) { invalid("can only delete own post"); continue; }
        await this.insert(id, h, rec.envelope, "direct");
        await this.attachBlobs(h);
        if (target) await this.dropBlobsOf(target);
      }
      results.push({ id, status: "ok" });
      onAccepted?.(h, id);
    }
    return results;
  }

  /**
   * ピアから同期で届いたレコードを保存する。署名と形式と deps の到着だけを確認し、
   * メンバー規則の判定は導出時に行う（ピア間で受け入れ判断が食い違って同期が詰まらないように）。
   */
  async ingestPeer(envelopes: unknown[]) {
    const results: IngestResult[] = [];
    const touched = new Set<string>();
    for (const env of envelopes) {
      let rec;
      try {
        rec = await openRecord(env);
      } catch (e) {
        results.push({ id: null, status: "invalid", reason: (e as Error).message });
        continue;
      }
      const { id, header: h } = rec;
      if (h.exp !== undefined && h.exp <= this.now()) { results.push({ id, status: "dup" }); continue; }
      if ((await this.existing([id])).size > 0) { results.push({ id, status: "dup" }); continue; }
      const have = await this.existing(h.deps);
      const miss = h.deps.filter((d) => !have.has(d));
      if (miss.length) { results.push({ id, status: "missing", missing: miss }); continue; }
      await this.insert(id, h, rec.envelope, "peer");
      await this.attachBlobs(h);
      if (h.kind === "post.delete") {
        const target = await this.deleteTarget(h);
        if (target) await this.dropBlobsOf(target);
      }
      if (isControlKind(h.kind)) touched.add(h.group);
      results.push({ id, status: "ok" });
    }
    for (const g of touched) await this.refreshGroup(g);
    return results;
  }

  async listRecords(grp: string | null, after: number, limit: number) {
    const now = this.now();
    const rows = grp
      ? await this.d.sql.all<{ seq: number; payload: string; sig: string }>(
          "SELECT seq, payload, sig FROM records WHERE grp = ? AND seq > ? AND (exp IS NULL OR exp > ?) ORDER BY seq LIMIT ?",
          grp, after, now, limit,
        )
      : await this.d.sql.all<{ seq: number; payload: string; sig: string }>(
          "SELECT seq, payload, sig FROM records WHERE seq > ? AND (exp IS NULL OR exp > ?) ORDER BY seq LIMIT ?",
          after, now, limit,
        );
    const last = rows.at(-1)?.seq ?? after;
    return { records: rows.map((r) => ({ payload: r.payload, sig: r.sig })), next: last, more: rows.length === limit };
  }

  async kvGet(k: string) {
    return (await this.d.sql.first<{ v: string }>("SELECT v FROM kv WHERE k = ?", k))?.v ?? null;
  }

  async kvSet(k: string, v: string) {
    await this.d.sql.run("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  }

  /** このデータベースの識別子。DB を作り直すと変わるので、ピアはこれで同期のやり直しを判断する */
  async instanceId() {
    const cur = await this.kvGet("instance_id");
    if (cur) return cur;
    const id = crypto.randomUUID();
    await this.d.sql.run("INSERT INTO kv (k, v) VALUES ('instance_id', ?) ON CONFLICT (k) DO NOTHING", id);
    return (await this.kvGet("instance_id"))!;
  }

  /** 期限切れのレコードと blob を消す */
  async collectGarbage() {
    const now = this.now();
    // アップロードだけされて post が来なかった blob も、作成から BLOB_GRACE_MS で期限切れになる
    const expired = await this.d.sql.all<{ id: string }>("SELECT id FROM blobs WHERE exp <= ? LIMIT 500", now);
    const ids = expired.map((r) => r.id);
    if (ids.length) {
      await this.d.blobs.delete(ids);
      await this.d.sql.batch(ids.map((id) => ({ sql: "DELETE FROM blobs WHERE id = ?", params: [id] })));
    }
    const r = await this.d.sql.run("DELETE FROM records WHERE exp IS NOT NULL AND exp <= ?", now);
    return { blobs: ids.length, records: r.changes };
  }
}
