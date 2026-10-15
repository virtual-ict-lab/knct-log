import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { AUTH_CONTEXT, fromB64u, isGroupId, sha256, toB64u, utf8, verify } from "@knct-log/core";
import type { Deps } from "./deps.ts";
import { hmac, hmacVerify, seal, unseal } from "./hmac.ts";
import { BLOB_GRACE_MS, Store } from "./store.ts";
import { notifyNewPost, pushRoutes } from "./push.ts";

export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const TOKEN_TTL_MS = 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 60 * 1000;
const URL_TTL_MS = 15 * 60 * 1000;
const MAX_BATCH = 64;
const ID = /^[A-Za-z0-9_-]{43}$/;

export type AppEnv = { Variables: { pk: string; peer: boolean } };

export function createApp(deps: Deps) {
  const store = new Store(deps);
  const now = () => store.now();
  const app = new Hono<AppEnv>();
  const base = (c: Context) => deps.publicUrl ?? new URL(c.req.url).origin;

  // Chrome の Private Network Access：公開オリジンの PWA から学内 IP への preflight を許可する
  app.use("*", async (c, next) => {
    await next();
    if (c.req.header("Access-Control-Request-Private-Network") === "true") {
      c.res.headers.set("Access-Control-Allow-Private-Network", "true");
    }
  });
  app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], maxAge: 86400 }));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/v1/health", async (c) => c.json({ server_id: deps.serverId, instance: await store.instanceId(), time: now() }));

  app.post("/v1/auth/challenge", async (c) => {
    const challenge = await seal(deps.secret, "challenge", { n: toB64u(crypto.getRandomValues(new Uint8Array(16))), exp: now() + CHALLENGE_TTL_MS });
    return c.json({ challenge });
  });

  app.post("/v1/auth/token", async (c) => {
    const { pk, challenge, sig } = await c.req.json<{ pk: string; challenge: string; sig: string }>();
    if (typeof pk !== "string" || typeof challenge !== "string" || typeof sig !== "string") return c.json({ error: "bad request" }, 400);
    if (!(await unseal(deps.secret, "challenge", challenge, now()))) return c.json({ error: "invalid challenge" }, 401);
    let sigBytes;
    try {
      sigBytes = fromB64u(sig);
    } catch {
      return c.json({ error: "bad signature" }, 401);
    }
    if (!(await verify(pk, utf8.encode(AUTH_CONTEXT + challenge), sigBytes))) return c.json({ error: "bad signature" }, 401);
    const exp = now() + TOKEN_TTL_MS;
    return c.json({ token: await seal(deps.secret, "token", { pk, exp }), exp, peer: deps.peerKeys.includes(pk) });
  });

  // 署名付き URL で直接やりとりする blob 本体（認証ヘッダー不要）
  app.put("/v1/blobs/raw/:id", async (c) => {
    const id = c.req.param("id");
    const size = Number(c.req.query("n"));
    const exp = Number(c.req.query("e"));
    if (!(exp > now()) || !(await hmacVerify(deps.secret, `put:${id}:${size}:${exp}`, c.req.query("s") ?? "")))
      return c.json({ error: "invalid url" }, 403);
    const data = new Uint8Array(await c.req.arrayBuffer());
    if (data.length !== size) return c.json({ error: "size mismatch" }, 400);
    if (toB64u(await sha256(data)) !== id) return c.json({ error: "hash mismatch" }, 400);
    await deps.blobs.put(id, data);
    await deps.sql.run("UPDATE blobs SET stored = 1, size = ? WHERE id = ?", size, id);
    return c.body(null, 204);
  });

  app.get("/v1/blobs/raw/:id", async (c) => {
    const id = c.req.param("id");
    const exp = Number(c.req.query("e"));
    if (!(exp > now()) || !(await hmacVerify(deps.secret, `get:${id}:${exp}`, c.req.query("s") ?? "")))
      return c.json({ error: "invalid url" }, 403);
    const body = await deps.blobs.get(id);
    if (!body) return c.json({ error: "not found" }, 404);
    return c.body(body, 200, { "Content-Type": "application/octet-stream", "Cache-Control": "private, max-age=86400, immutable" });
  });

  // ここから下は Bearer トークン必須
  const authed = new Hono<AppEnv>();
  authed.use("*", async (c, next) => {
    const auth = c.req.header("Authorization") ?? "";
    const tok = auth.startsWith("Bearer ") ? await unseal<{ pk: string; exp: number }>(deps.secret, "token", auth.slice(7), now()) : null;
    if (!tok) return c.json({ error: "unauthorized" }, 401);
    c.set("pk", tok.pk);
    c.set("peer", deps.peerKeys.includes(tok.pk));
    await next();
  });

  authed.get("/me/groups", async (c) => {
    const rows = await deps.sql.all<{ grp: string; admin: string | null; dissolved: number }>(
      "SELECT g.grp, g.admin, g.dissolved FROM members m JOIN groups g ON g.grp = m.grp WHERE m.pk = ?",
      c.get("pk"),
    );
    return c.json({ groups: rows.map((r) => ({ group: r.grp, admin: r.admin, dissolved: r.dissolved === 1 })) });
  });

  authed.post("/groups/:gid/records", async (c) => {
    const gid = c.req.param("gid");
    if (!isGroupId(gid)) return c.json({ error: "invalid group" }, 400);
    const { records } = await c.req.json<{ records: unknown[] }>();
    if (!Array.isArray(records) || records.length > MAX_BATCH) return c.json({ error: "bad request" }, 400);
    const results = await store.ingestDirect(gid, c.get("pk"), records, (h, id) => {
      if (h.kind === "post" && deps.pusher) deps.defer?.(notifyNewPost(deps, store, h, id));
    });
    return c.json({ results });
  });

  authed.get("/groups/:gid/records", async (c) => {
    const gid = c.req.param("gid");
    if (!c.get("peer") && !(await store.isMember(gid, c.get("pk")))) return c.json({ error: "forbidden" }, 403);
    const { after, limit } = page(c);
    return c.json(await store.listRecords(gid, after, limit));
  });

  authed.post("/blobs/upload-url", async (c) => {
    const { group, id, size } = await c.req.json<{ group: string; id: string; size: number }>();
    if (!isGroupId(group) || typeof id !== "string" || !ID.test(id)) return c.json({ error: "bad request" }, 400);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BLOB_BYTES) return c.json({ error: "invalid size" }, 413);
    if (!c.get("peer") && !(await store.isMember(group, c.get("pk")))) return c.json({ error: "forbidden" }, 403);
    await deps.sql.run(
      "INSERT INTO blobs (id, grp, size, exp, stored, created_at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT (id) DO NOTHING",
      id, group, size, now() + BLOB_GRACE_MS, now(),
    );
    const row = await deps.sql.first<{ grp: string; stored: number }>("SELECT grp, stored FROM blobs WHERE id = ?", id);
    if (row?.grp !== group) return c.json({ error: "blob belongs to another group" }, 409);
    if (row.stored === 1) return c.json({ stored: true });
    if (deps.blobUrls) return c.json({ stored: false, ...(await deps.blobUrls.upload(id, size)) });
    const exp = now() + URL_TTL_MS;
    const s = await hmac(deps.secret, `put:${id}:${size}:${exp}`);
    return c.json({ stored: false, url: `${base(c)}/v1/blobs/raw/${id}?n=${size}&e=${exp}&s=${s}`, headers: {} });
  });

  authed.post("/blobs/download-url", async (c) => {
    const { id } = await c.req.json<{ id: string }>();
    if (typeof id !== "string" || !ID.test(id)) return c.json({ error: "bad request" }, 400);
    const row = await deps.sql.first<{ grp: string }>("SELECT grp FROM blobs WHERE id = ?", id);
    if (!row || !(await store.storedBlobs([id])).has(id)) return c.json({ error: "not found" }, 404);
    if (!c.get("peer") && !(await store.isMember(row.grp, c.get("pk")))) return c.json({ error: "forbidden" }, 403);
    if (deps.blobUrls) return c.json({ url: await deps.blobUrls.download(id) });
    const exp = now() + URL_TTL_MS;
    const s = await hmac(deps.secret, `get:${id}:${exp}`);
    return c.json({ url: `${base(c)}/v1/blobs/raw/${id}?e=${exp}&s=${s}` });
  });

  // ピア間同期
  authed.use("/peer/*", async (c, next) => {
    if (!c.get("peer")) return c.json({ error: "forbidden" }, 403);
    await next();
  });
  authed.get("/peer/records", async (c) => {
    const { after, limit } = page(c);
    return c.json(await store.listRecords(null, after, limit));
  });
  authed.post("/peer/records", async (c) => {
    const { records } = await c.req.json<{ records: unknown[] }>();
    if (!Array.isArray(records) || records.length > MAX_BATCH * 4) return c.json({ error: "bad request" }, 400);
    return c.json({ results: await store.ingestPeer(records) });
  });

  pushRoutes(authed, deps, store);
  app.route("/v1", authed);
  return { app, store };
}

function page(c: Context) {
  const after = Math.max(0, Number(c.req.query("after") ?? 0) || 0);
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 200) || 200));
  return { after, limit };
}
