import type { Hono } from "hono";
import { type Envelope, openAccountDoc } from "@knct-log/core";
import type { AppEnv } from "./app.ts";
import type { Store } from "./store.ts";

const PK = /^[A-Za-z0-9_-]{43}$/;
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
const BATCH = 200;

interface Row {
  pk: string;
  ts: number;
  payload: string;
  sig: string;
  updated_at: number;
}

/** 署名を確かめて保存する。ts が新しいときだけ置き換える（LWW） */
export async function upsertAccount(store: Store, env: Envelope): Promise<"ok" | "same" | "stale" | "invalid"> {
  let doc;
  try {
    doc = await openAccountDoc(env);
  } catch {
    return "invalid";
  }
  if (doc.ts > store.now() + MAX_CLOCK_SKEW_MS) return "invalid";
  const r = await store.sql.run(
    `INSERT INTO accounts (pk, ts, payload, sig, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (pk) DO UPDATE SET ts = excluded.ts, payload = excluded.payload, sig = excluded.sig, updated_at = excluded.updated_at
     WHERE excluded.ts > accounts.ts`,
    doc.account, doc.ts, env.payload, env.sig, store.now(),
  );
  if (r.changes > 0) return "ok";
  const cur = await store.sql.first<{ payload: string }>("SELECT payload FROM accounts WHERE pk = ?", doc.account);
  return cur?.payload === env.payload ? "same" : "stale";
}

/** アカウント文書。中身は暗号文なので取得は認証なし、更新はアカウント鍵の署名で守る */
export function accountRoutes(app: Hono<AppEnv>, authed: Hono<AppEnv>, store: Store) {
  app.get("/v1/accounts/:pk", async (c) => {
    const pk = c.req.param("pk");
    if (!PK.test(pk)) return c.json({ error: "bad request" }, 400);
    const row = await store.sql.first<Row>("SELECT payload, sig FROM accounts WHERE pk = ?", pk);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ payload: row.payload, sig: row.sig }, 200, { "Cache-Control": "no-store" });
  });

  app.put("/v1/accounts", async (c) => {
    const env = await c.req.json<Envelope>().catch(() => null);
    const res = env ? await upsertAccount(store, env) : "invalid";
    if (res === "invalid") return c.json({ error: "invalid account doc" }, 400);
    if (res === "stale") return c.json({ error: "a newer version exists" }, 409);
    return c.body(null, 204);
  });

  authed.get("/peer/accounts", async (c) => {
    const since = Number(c.req.query("since") ?? 0) || 0;
    const rows = await store.sql.all<Row>(
      "SELECT pk, ts, payload, sig, updated_at FROM accounts WHERE updated_at > ? ORDER BY updated_at LIMIT ?",
      since, BATCH,
    );
    return c.json({ accounts: rows.map((r) => ({ payload: r.payload, sig: r.sig, updated_at: r.updated_at })) });
  });

  authed.post("/peer/accounts", async (c) => {
    const { accounts } = await c.req.json<{ accounts: Envelope[] }>();
    if (!Array.isArray(accounts)) return c.json({ error: "bad request" }, 400);
    for (const env of accounts.slice(0, BATCH)) await upsertAccount(store, { payload: env.payload, sig: env.sig });
    return c.body(null, 204);
  });
}
