import type { Hono } from "hono";
import { buildPushPayload, type VapidKeys } from "@block65/webcrypto-web-push";
import type { Header } from "@knct-log/core";
import type { Deps, PushSubscription, Pusher } from "./deps.ts";
import type { AppEnv } from "./app.ts";
import type { Store } from "./store.ts";

/** Web Push の送信（VAPID 鍵は全ピアで共有する） */
export function webPusher(vapid: VapidKeys): Pusher {
  return {
    async send(subs, data) {
      const gone: string[] = [];
      await Promise.all(
        subs.map(async (s) => {
          try {
            const payload = await buildPushPayload(
              { data: data as never, options: { ttl: 30 * 60, urgency: "normal" } },
              { endpoint: s.endpoint, expirationTime: null, keys: { p256dh: s.p256dh, auth: s.auth } },
              vapid,
            );
            const res = await fetch(s.endpoint, payload);
            if (res.status === 404 || res.status === 410) gone.push(s.endpoint);
          } catch (e) {
            console.warn("push failed", s.endpoint, e);
          }
        }),
      );
      return { gone };
    },
  };
}

interface SubRow {
  endpoint: string;
  pk: string;
  p256dh: string;
  auth: string;
  deleted: number;
  updated_at: number;
}

async function upsertSubs(store: Store, rows: SubRow[]) {
  if (rows.length === 0) return;
  // updated_at が新しい方を採用（ピア間で LWW）
  await store.sql.batch(
    rows.map((r) => ({
      sql: `INSERT INTO push_subs (endpoint, pk, p256dh, auth, deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (endpoint) DO UPDATE SET pk = excluded.pk, p256dh = excluded.p256dh, auth = excluded.auth,
              deleted = excluded.deleted, updated_at = excluded.updated_at
            WHERE excluded.updated_at > push_subs.updated_at`,
      params: [r.endpoint, r.pk, r.p256dh, r.auth, r.deleted, r.updated_at],
    })),
  );
}

async function markGone(store: Store, endpoints: string[]) {
  const now = store.now();
  await store.sql.batch(
    endpoints.map((e) => ({ sql: "UPDATE push_subs SET deleted = 1, updated_at = ? WHERE endpoint = ?", params: [now, e] })),
  );
}

export function pushRoutes(authed: Hono<AppEnv>, deps: Deps, store: Store) {
  authed.post("/push/subscribe", async (c) => {
    const { endpoint, keys } = await c.req.json<{ endpoint: string; keys: { p256dh: string; auth: string } }>();
    if (typeof endpoint !== "string" || !endpoint.startsWith("https://") || typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string")
      return c.json({ error: "bad request" }, 400);
    await upsertSubs(store, [{ endpoint, pk: c.get("pk"), p256dh: keys.p256dh, auth: keys.auth, deleted: 0, updated_at: store.now() }]);
    return c.body(null, 204);
  });

  authed.post("/push/unsubscribe", async (c) => {
    const { endpoint } = await c.req.json<{ endpoint: string }>();
    await store.sql.run("UPDATE push_subs SET deleted = 1, updated_at = ? WHERE endpoint = ? AND pk = ?", store.now(), endpoint, c.get("pk"));
    return c.body(null, 204);
  });

  authed.get("/peer/push-subs", async (c) => {
    const since = Number(c.req.query("since") ?? 0) || 0;
    const subs = await store.sql.all<SubRow>(
      "SELECT endpoint, pk, p256dh, auth, deleted, updated_at FROM push_subs WHERE updated_at > ? ORDER BY updated_at LIMIT 500",
      since,
    );
    return c.json({ subs });
  });
  authed.post("/peer/push-subs", async (c) => {
    const { subs } = await c.req.json<{ subs: SubRow[] }>();
    await upsertSubs(store, subs.slice(0, 500));
    return c.body(null, 204);
  });

  authed.get("/peer/push-slots", async (c) => {
    const since = Number(c.req.query("since") ?? 0) || 0;
    return c.json({ slots: await store.sql.all("SELECT slot, sent_by, sent_at FROM push_slots WHERE sent_at > ? ORDER BY sent_at LIMIT 500", since) });
  });
  authed.post("/peer/push-slots", async (c) => {
    const { slots } = await c.req.json<{ slots: { slot: string; sent_by: string; sent_at: number }[] }>();
    await store.sql.batch(
      slots.slice(0, 500).map((s) => ({
        sql: "INSERT INTO push_slots (slot, sent_by, sent_at) VALUES (?, ?, ?) ON CONFLICT (slot) DO NOTHING",
        params: [s.slot, s.sent_by, s.sent_at],
      })),
    );
    return c.body(null, 204);
  });
}

async function subsFor(store: Store, pks: string[]): Promise<PushSubscription[]> {
  if (pks.length === 0) return [];
  return store.sql.all<PushSubscription>(
    `SELECT endpoint, p256dh, auth FROM push_subs WHERE deleted = 0 AND pk IN (${pks.map(() => "?").join(",")})`,
    ...pks,
  );
}

/** 新着通知。クライアントから直接受け取ったピアだけが送る。中身は含めない。 */
export async function notifyNewPost(deps: Deps, store: Store, h: Header, _id: string) {
  const members = await store.sql.all<{ pk: string }>("SELECT pk FROM members WHERE grp = ? AND pk != ?", h.group, h.author);
  const subs = await subsFor(store, members.map((m) => m.pk));
  const { gone } = await deps.pusher!.send(subs, { t: "post", g: h.group });
  await markGone(store, gone);
}

export function hourSlot(now: number) {
  return new Date(now).toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
}

/**
 * 毎時プロンプト。そのスロットがまだどのピアからも送られていなければ、活動時間帯のグループのメンバーに送る。
 * CF は毎時 0 分の Cron で、学内は数分遅れて呼ぶ（CF が送っていればスロットが同期済みなので送らない）。
 */
export async function runHourlyPrompt(deps: Deps, store: Store) {
  if (!deps.pusher) return { sent: 0, skipped: "no pusher" };
  const now = store.now();
  const slot = hourSlot(now);
  const claimed = await store.sql.run(
    "INSERT INTO push_slots (slot, sent_by, sent_at) VALUES (?, ?, ?) ON CONFLICT (slot) DO NOTHING",
    slot, deps.serverId, now,
  );
  if (claimed.changes === 0) return { sent: 0, skipped: "slot already sent" };

  const groups = await store.sql.all<{ grp: string; hours_start: number; hours_end: number; utc_offset_min: number }>(
    "SELECT grp, hours_start, hours_end, utc_offset_min FROM groups WHERE dissolved = 0",
  );
  const active = groups.filter((g) => {
    const local = new Date(now + g.utc_offset_min * 60_000).getUTCHours();
    return local >= g.hours_start && local < g.hours_end;
  });
  if (active.length === 0) return { sent: 0 };
  const members = await store.sql.all<{ pk: string }>(
    `SELECT DISTINCT pk FROM members WHERE grp IN (${active.map(() => "?").join(",")})`,
    ...active.map((g) => g.grp),
  );
  const subs = await subsFor(store, members.map((m) => m.pk));
  const { gone } = await deps.pusher.send(subs, { t: "prompt", slot });
  await markGone(store, gone);
  return { sent: subs.length };
}
