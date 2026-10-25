import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { fromB64u, randomBytes, toB64u } from "@knct-log/core";
import { inProcessServer } from "@knct-log/server-campus/testing";
import { openLocalDb } from "../src/lib/db.ts";
import { Engine } from "../src/lib/engine.ts";
import type { Passkey } from "../src/lib/passkey.ts";

/** 同期されるパスキー（Google パスワードマネージャーなど）の代わり。端末をまたいで同じ PRF を返す */
function fakePasskeyManager() {
  const creds = new Map<string, { account: string; prf: Uint8Array<ArrayBuffer> }>();
  const make = (pick: () => string | undefined): Passkey => ({
    async register(account) {
      const credId = toB64u(randomBytes(16));
      creds.set(credId, { account, prf: randomBytes(32) });
      return { credId, prf: creds.get(credId)!.prf };
    },
    async authenticate() {
      const credId = pick() ?? [...creds.keys()].at(-1)!;
      return { credId, ...creds.get(credId)! };
    },
  });
  return { passkey: make(() => undefined), creds, forAccount: (a: string) => make(() => [...creds].find(([, c]) => c.account === a)?.[0]) };
}

let n = 0;
async function blankEngine(server: ReturnType<typeof inProcessServer>) {
  const db = await openLocalDb(`test-${++n}`);
  const e = new Engine(db, {
    fetch: server.fetch,
    picker: async (eps) => ({ endpoint: eps[0]!, serverId: server.deps.serverId }),
  });
  await e.setEndpoints([{ url: server.baseUrl, label: "test" }]);
  return e;
}

async function newEngine(server: ReturnType<typeof inProcessServer>, name: string, passkey: Passkey | null = null) {
  const e = await blankEngine(server);
  await e.createAccount(name, passkey);
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
    await bob.post([group], video, "video/mp4", 3000, Date.now(), "  部室なう ");
    await settle(alice, bob, carol);
    const posts = await alice.posts(group);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.authorName).toBe("ボブ");
    expect(posts[0]!.content!.text).toBe("部室なう");

    // リアクション（同じ絵文字で取り消し）と返信
    await alice.react(posts[0]!, "🔥");
    await carol.react((await carol.posts(group))[0]!, "🔥");
    await carol.reply((await carol.posts(group))[0]!, "いいね");
    await settle(alice, bob, carol);
    let seen = (await bob.posts(group))[0]!;
    expect(seen.reactions).toEqual([{ emoji: "🔥", count: 2, mine: false }]);
    expect(seen.replies.map((r) => [r.authorName, r.text])).toEqual([["キャロル", "いいね"]]);
    await alice.react((await alice.posts(group))[0]!, "🔥");
    await alice.react((await alice.posts(group))[0]!, "😂");
    await settle(alice, bob, carol);
    seen = (await alice.posts(group))[0]!;
    expect(seen.reactions.sort((x, y) => x.emoji.localeCompare(y.emoji))).toEqual([
      { emoji: "😂", count: 1, mine: true },
      { emoji: "🔥", count: 1, mine: false },
    ].sort((x, y) => x.emoji.localeCompare(y.emoji)));
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

  it("moves an account to a new device with a synced passkey and keeps reading the group", async () => {
    const server = inProcessServer("cf");
    const pm = fakePasskeyManager();
    const phone = await newEngine(server, "アリス", pm.passkey);
    const bob = await newEngine(server, "ボブ");
    const group = await phone.createGroup("プロコン");
    const link = new URL(await phone.createInviteLink(group, "https://app.test"));
    const q = new URLSearchParams(link.hash.split("?")[1]);
    await bob.join(q.get("g")!, q.get("i")!, q.get("t")!);
    await settle(phone, bob);
    await bob.post([group], randomBytes(500), "video/mp4", 3000, Date.now());
    await settle(phone, bob);
    expect((await phone.accountInfo())!.passkeys).toBe(1);

    // 新しい端末でパスキーでログイン → 同じアカウントで、グループと過去の投稿が見える
    const laptop = await blankEngine(server);
    await laptop.signInWithPasskey(pm.passkey);
    expect(laptop.me).toBe(phone.me);
    expect(laptop.name).toBe("アリス");
    await settle(laptop);
    const v = await laptop.groupView(group);
    expect(v.isMember && v.isAdmin && v.hasKey).toBe(true);
    expect((await laptop.posts(group))[0]!.content).not.toBeNull();

    // どちらの端末からも投稿でき、名前の変更は他の端末に伝わる
    await laptop.post([group], randomBytes(400), "video/mp4", 3000, Date.now());
    await laptop.rename("ありす");
    await settle(laptop, phone, bob);
    expect(phone.name).toBe("ありす");
    expect((await bob.groupView(group)).members.find((m) => m.pk === phone.me)!.name).toBe("ありす");
    expect(await phone.postedThisHour(group)).toBe(true);

    // 一方の端末で作ったグループも、もう一方に現れる
    const g2 = await phone.createGroup("二つ目");
    await settle(phone, laptop);
    expect((await laptop.groups()).map((g) => g.group)).toContain(g2);

    // ログアウトしても、同じ端末でパスキーからログインし直せる
    await laptop.signOut();
    expect(laptop.account).toBeNull();
    await laptop.signInWithPasskey(pm.passkey);
    expect(laptop.me).toBe(phone.me);

    // 別の PRF（別のパスキー）では開けない
    const other = await blankEngine(server);
    const wrong: Passkey = { register: pm.passkey.register, authenticate: async () => ({ ...(await pm.passkey.authenticate()), prf: randomBytes(32) }) };
    await expect(other.signInWithPasskey(wrong)).rejects.toThrow();
    expect(other.account).toBeNull();
  });

  it("hands over an account with a one-time QR link", async () => {
    const server = inProcessServer("cf");
    const old = await newEngine(server, "ボブ"); // パスキーなし
    const group = await old.createGroup("g");
    await settle(old);
    const { url, id } = await old.createDeviceLink("https://app.test");
    expect((await old.accountInfo())!.links.map((l) => l.id)).toEqual([id]);
    const q = new URLSearchParams(new URL(url).hash.split("?")[1]);

    const fresh = await blankEngine(server);
    await fresh.acceptLink(q.get("a")!, q.get("u")!, q.get("k")!, 0);
    expect(fresh.me).toBe(old.me);
    await settle(fresh, old);
    expect((await fresh.groupView(group)).hasKey).toBe(true);
    // 使ったリンクは消えていて、二度は使えない
    expect((await old.accountInfo())!.links).toEqual([]);
    const again = await blankEngine(server);
    await expect(again.acceptLink(q.get("a")!, q.get("u")!, q.get("k")!, 0)).rejects.toThrow();
    // 秘密を変えたリンクも使えない
    const { url: url2 } = await old.createDeviceLink("https://app.test");
    const q2 = new URLSearchParams(new URL(url2).hash.split("?")[1]);
    const bad = toB64u(fromB64u(q2.get("k")!).map((b) => b ^ 1));
    await expect(again.acceptLink(q2.get("a")!, q2.get("u")!, bad, 0)).rejects.toThrow();
  });

  it("tracks unread posts per device", async () => {
    const server = inProcessServer("cf");
    const alice = await newEngine(server, "アリス");
    const bob = await newEngine(server, "ボブ");
    const group = await alice.createGroup("プロコン");
    const q = new URLSearchParams(new URL(await alice.createInviteLink(group, "https://app.test")).hash.split("?")[1]);
    await bob.join(q.get("g")!, q.get("i")!, q.get("t")!);
    await settle(alice, bob);

    // 初めて見るまでは、それまでの投稿は未読にしない
    await bob.post([group], randomBytes(100), "video/mp4", 3000, Date.now() - 3600_000);
    await settle(alice, bob);
    expect((await alice.posts(group)).map((p) => p.unread)).toEqual([false]);
    await alice.markSeen(group, []);

    await bob.post([group], randomBytes(100), "video/mp4", 3000, Date.now());
    await alice.post([group], randomBytes(100), "video/mp4", 3000, Date.now());
    await settle(alice, bob);
    const posts = await alice.posts(group);
    expect(posts.filter((p) => p.unread).map((p) => p.author)).toEqual([bob.me]);

    await alice.markSeen(group, posts);
    expect((await alice.posts(group)).some((p) => p.unread)).toBe(false);

    // トーク表示のように 1 件ずつ同時に既読にしても取りこぼさない
    await bob.post([group], randomBytes(100), "video/mp4", 3000, Date.now());
    await bob.post([group], randomBytes(100), "video/mp4", 3000, Date.now());
    await settle(alice, bob);
    const fresh = (await alice.posts(group)).filter((p) => p.unread);
    expect(fresh).toHaveLength(2);
    await Promise.all(fresh.map((p) => alice.markSeen(group, [p])));
    expect((await alice.posts(group)).some((p) => p.unread)).toBe(false);
  });
});
