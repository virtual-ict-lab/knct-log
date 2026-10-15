import { AwsClient } from "aws4fetch";
import {
  type BlobStore,
  type BlobUrls,
  type Deps,
  type Sql,
  Store,
  createApp,
  runHourlyPrompt,
  webPusher,
} from "@knct-log/server-app";

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  SERVER_ID?: string;
  SECRET: string;
  /** カンマ区切りのピア公開鍵（学内サーバー） */
  PEER_KEYS?: string;
  PUBLIC_URL?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** 設定すると blob を R2 の S3 presigned URL で直接やりとりする（Worker を経由しない） */
  R2_ACCOUNT_ID?: string;
  R2_BUCKET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

function d1Sql(db: D1Database): Sql {
  const bind = (sql: string, params: unknown[]) => db.prepare(sql).bind(...params);
  return {
    async all<T>(sql: string, ...params: unknown[]) {
      return (await bind(sql, params).all<T>()).results;
    },
    async first<T>(sql: string, ...params: unknown[]) {
      return (await bind(sql, params).first<T>()) ?? null;
    },
    async run(sql: string, ...params: unknown[]) {
      return { changes: (await bind(sql, params).run()).meta.changes ?? 0 };
    },
    async batch(stmts) {
      if (stmts.length) await db.batch(stmts.map((s) => bind(s.sql, s.params)));
    },
  };
}

function r2Store(bucket: R2Bucket): BlobStore {
  return {
    async put(id, data) {
      await bucket.put(id, data);
    },
    async get(id) {
      return (await bucket.get(id))?.body ?? null;
    },
    async delete(ids) {
      if (ids.length) await bucket.delete(ids);
    },
    async head(id) {
      return (await bucket.head(id))?.size ?? null;
    },
  };
}

function r2Presigned(env: Env): BlobUrls | undefined {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET) return undefined;
  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const sign = async (id: string, method: "PUT" | "GET", headers: Record<string, string> = {}) => {
    const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${id}`);
    url.searchParams.set("X-Amz-Expires", "900");
    const req = await aws.sign(new Request(url, { method, headers }), { aws: { signQuery: true } });
    return req.url;
  };
  return {
    async upload(id) {
      return { url: await sign(id, "PUT"), headers: {} };
    },
    download: (id) => sign(id, "GET"),
  };
}

function makeDeps(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Deps {
  if (!env.SECRET) throw new Error("SECRET is not configured");
  return {
    sql: d1Sql(env.DB),
    blobs: r2Store(env.BLOBS),
    blobUrls: r2Presigned(env),
    serverId: env.SERVER_ID ?? "cf",
    secret: env.SECRET,
    peerKeys: (env.PEER_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    publicUrl: env.PUBLIC_URL,
    pusher: env.VAPID_PRIVATE_KEY
      ? webPusher({ subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY })
      : undefined,
    defer: (p) => ctx.waitUntil(p),
  };
}

export default {
  fetch(req, env, ctx) {
    return createApp(makeDeps(env, ctx)).app.fetch(req, env, ctx);
  },

  // 毎時 0 分：プロンプト送信と期限切れの削除
  async scheduled(_event, env, ctx) {
    const deps = makeDeps(env, ctx);
    const store = new Store(deps);
    console.log("hourly prompt", await runHourlyPrompt(deps, store));
    console.log("gc", await store.collectGarbage());
  },
} satisfies ExportedHandler<Env>;
