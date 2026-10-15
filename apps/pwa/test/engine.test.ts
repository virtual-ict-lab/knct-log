import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { randomBytes } from "@knct-log/core";
import { inProcessServer } from "@knct-log/server-campus/testing";
import { openLocalDb } from "../src/lib/db.ts";
import { Engine } from "../src/lib/engine.ts";

let n = 0;
async function newEngine(server: ReturnType<typeof inProcessServer>, name: string) {
  const db = await openLocalDb(`test-${++n}`);
  const e = new Engine(db, {
    fetch: server.fetch,
    picker: async (eps) => ({ endpoint: eps[0]!, serverId: server.deps.serverId }),
  });
  await e.setEndpoints([{ url: server.baseUrl, label: "test" }]);
  await e.setupDevice(name);
  return e;
}

async function settle(...engines: Engine[]) {
  for (let i = 0; i < 4; i++) for (const e of engines) await e.sync();
}

describe("engine", () => {
  it("creates, invites, joins, posts, transfers admin and leaves", async () => {
    const server = inProcessServer("cf");
    const alice = await newEngine(server, "アリス");
    const bob = await newEngine(server, "ボブ");
    const carol = await newEngine(server, "キャロル");

    const group = await alice.createGroup("プロコン");
    const link = new URL(await alice.createInviteLink(group, "https://app.test"));
    const q = new URLSearchParams(link.hash.split("?")[1]);
    await bob.join(q.get("g")!, q.get("i")!, q.get("t")!);
    await carol.join(q.get("g")!, q.get("i")!, q.get("t")!);
    await settle(alice, bob, carol);

    const bv = await bob.groupView(group);
    expect(bv.isMember).toBe(true);
    expect(bv.hasKey).toBe(true);
    expect(bv.name).toBe("プロコン");
    expect(bv.members.map((m) => m.name).sort()).toEqual(["アリス", "キャロル", "ボブ"]);

    // 投稿と再生
    const video = randomBytes(3000);
    await bob.post([group], video, "video/mp4", 3000, Date.now());
    await settle(alice, bob, carol);
    const posts = await alice.posts(group);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.authorName).toBe("ボブ");
    const blob = await alice.video(posts[0]!);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(video);
    expect(await bob.postedThisHour(group)).toBe(true);

    // 管理者をボブに移譲してアリスが退会 → ボブが鍵をローテーション
    const epochBefore = (await bob.state(group)).currentEpoch;
    await alice.transferAdmin(group, bob.me!);
    await settle(alice, bob, carol);
    expect((await carol.groupView(group)).isAdmin).toBe(false);
    expect((await carol.state(group)).admin).toBe(bob.me);
    expect(await alice.leave(group)).toBe(true);
    expect(await alice.groups()).toEqual([]);
    await settle(bob, carol);
    const s = await carol.state(group);
    expect(s.members.has(alice.me!)).toBe(false);
    expect(s.currentEpoch).not.toBe(epochBefore);
    expect(s.uncoveredLeaves).toEqual([]);
    expect((await carol.groupView(group)).hasKey).toBe(true);

    // 新しい epoch でも投稿・閲覧できる
    await carol.post([group], randomBytes(100), "video/mp4", 3000, Date.now());
    await settle(bob, carol);
    expect((await bob.posts(group)).map((p) => p.authorName)).toContain("キャロル");
  });
});
