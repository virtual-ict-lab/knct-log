import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type Deps, type Pusher } from "@knct-log/server-app";
import { openSqlite } from "../src/sqlite.ts";
import { fsBlobStore } from "../src/fsblobs.ts";

/** ネットワークを使わずに app.fetch へ直接つなぐテスト用サーバー */
export function inProcessServer(serverId: string, opts: { peerKeys?: string[]; pusher?: Pusher; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `knct-${serverId}-`));
  const deps: Deps = {
    sql: openSqlite(":memory:"),
    blobs: fsBlobStore(dir),
    serverId,
    secret: `secret-${serverId}`,
    peerKeys: opts.peerKeys ?? [],
    publicUrl: `http://${serverId}.test`,
    pusher: opts.pusher,
    now: opts.now,
  };
  const { app, store } = createApp(deps);
  const state = { down: false };
  const fetchFn: typeof fetch = async (input, init) => {
    if (state.down) throw new TypeError("fetch failed (server down)");
    return app.fetch(new Request(input, init));
  };
  return { app, store, deps, baseUrl: `http://${serverId}.test`, fetch: fetchFn, state };
}

export function countingPusher() {
  const sent: { endpoint: string; payload: unknown }[] = [];
  const pusher: Pusher = {
    async send(subs, payload) {
      for (const s of subs) sent.push({ endpoint: s.endpoint, payload });
      return { gone: [] };
    },
  };
  return { pusher, sent };
}
