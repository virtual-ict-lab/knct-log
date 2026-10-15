import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp, runHourlyPrompt, webPusher, type Deps } from "@knct-log/server-app";
import { openSqlite } from "./sqlite.ts";
import { fsBlobStore } from "./fsblobs.ts";
import { peerSigner } from "./peer-key.ts";
import { SyncWorker } from "./sync.ts";

const env = process.env;
const required = (k: string) => {
  const v = env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

const dataDir = env.DATA_DIR ?? "./data";
mkdirSync(join(dataDir, "blobs"), { recursive: true });

const pending = new Set<Promise<unknown>>();
const deps: Deps = {
  sql: openSqlite(join(dataDir, "knct-log.sqlite")),
  blobs: fsBlobStore(join(dataDir, "blobs")),
  serverId: env.SERVER_ID ?? "campus",
  secret: required("SECRET"),
  peerKeys: (env.PEER_KEYS ?? "").split(",").filter(Boolean),
  publicUrl: env.PUBLIC_URL,
  pusher: env.VAPID_PRIVATE_KEY
    ? webPusher({ subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY })
    : undefined,
  defer: (p) => {
    pending.add(p);
    p.catch((e) => console.error("background task failed", e)).finally(() => pending.delete(p));
  },
};

const { app, store } = createApp(deps);

// PWA の静的配信（CF 障害中に新しくインストールする人のため）
if (env.STATIC_DIR) {
  app.use("/*", serveStatic({ root: env.STATIC_DIR }));
  app.get("*", serveStatic({ root: env.STATIC_DIR, path: "index.html" }));
}

const port = Number(env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`knct-log campus listening on :${port}`));

// ---- バックグラウンド処理 ----
const sync = env.PEER_URL && env.PEER_SIGNING_KEY
  ? new SyncWorker(env.PEER_URL, await peerSigner(env.PEER_SIGNING_KEY), deps, store)
  : null;
if (!sync) console.log("PEER_URL not set: running standalone (no sync)");

const SYNC_INTERVAL_MS = Number(env.SYNC_INTERVAL_MS ?? 10_000);
// CF の毎時 0 分の Cron に任せ、この分数を過ぎてもスロットが未送信なら学内から送る
const PROMPT_DELAY_MIN = Number(env.PROMPT_DELAY_MIN ?? (sync ? 3 : 0));

async function syncLoop() {
  try {
    const r = await sync!.runOnce();
    if (r && (r.pulled || r.pushed || r.blobs)) console.log("sync", r);
  } catch (e) {
    console.warn("sync failed:", (e as Error).message);
  }
  setTimeout(syncLoop, SYNC_INTERVAL_MS);
}
if (sync) void syncLoop();

let lastGc = 0;
setInterval(async () => {
  try {
    if (new Date().getUTCMinutes() >= PROMPT_DELAY_MIN) {
      const r = await runHourlyPrompt(deps, store);
      if (r.sent) console.log("hourly prompt", r);
    }
    if (Date.now() - lastGc > 60 * 60 * 1000) {
      lastGc = Date.now();
      console.log("gc", await store.collectGarbage());
    }
  } catch (e) {
    console.error("scheduler failed", e);
  }
}, 30_000);
