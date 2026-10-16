import { describe, expect, it } from "vitest";
import {
  type AccountDoc,
  ApiClient,
  type PostContent,
  cryptoKeySigner,
  deriveKek,
  generateAccountSecret,
  importAccountKeys,
  makeUnlock,
  newAmk,
  openAccountDoc,
  sealBundle,
  signAccountDoc,
  createGroup,
  createInvite,
  createPost,
  decryptBlob,
  deriveGroupState,
  encryptBlob,
  joinGroup,
  leaveGroup,
  openContent,
  randomBytes,
  transferAdmin,
} from "@knct-log/core";
import { allRecords, newDevice } from "@knct-log/conformance";
import { runHourlyPrompt } from "@knct-log/server-app";
import { generatePeerKey, peerSigner } from "../src/peer-key.ts";
import { SyncWorker } from "../src/sync.ts";
import { countingPusher, inProcessServer } from "./helpers.ts";

async function setup() {
  const key = await generatePeerKey();
  const cfPush = countingPusher();
  const campusPush = countingPusher();
  const cf = inProcessServer("cf", { peerKeys: [key.publicKey], pusher: cfPush.pusher });
  const campus = inProcessServer("campus", { pusher: campusPush.pusher });
  const sync = new SyncWorker(cf.baseUrl, await peerSigner(key.privatePkcs8), campus.deps, campus.store, cf.fetch);
  return { cf, campus, sync, cfPush, campusPush };
}

async function snapshot(api: Parameters<typeof allRecords>[0], group: string) {
  const s = await deriveGroupState(group, await allRecords(api, group));
  return { admin: s.admin, members: [...s.members.keys()].sort(), epoch: s.currentEpoch, applied: [...s.applied].sort() };
}

describe("campus <-> cf sync", () => {
  it("replicates groups, joins, posts and blobs in both directions", async () => {
    const { cf, campus, sync } = await setup();
    const alice = await newDevice(cf); // 学外
    const bob = await newDevice(campus); // 学内

    const g = await createGroup(alice, { name: "procon" });
    await alice.api.postRecords(g.group, g.records.map((r) => r.envelope));
    const { record: inv, token } = await createInvite(alice, await deriveGroupState(g.group, g.records));
    await alice.api.postRecords(g.group, [inv.envelope]);

    // 同期前は学内に招待がないので参加できない
    const join = await joinGroup(bob, g.group, inv.id, token);
    expect((await bob.api.postRecords(g.group, [join.envelope])).results[0]!.status).toBe("missing");
    await sync.runOnce();
    expect((await bob.api.postRecords(g.group, [join.envelope])).results[0]!.status).toBe("ok");

    // 学内で投稿
    const s = await deriveGroupState(g.group, await allRecords(bob.api, g.group));
    const video = randomBytes(2048);
    const blob = await encryptBlob(video);
    await bob.api.uploadBlob(g.group, blob.blobId, blob.sealed);
    const content: PostContent = { ck: blob.ck, mime: "video/mp4", durationMs: 3000, takenAt: Date.now() };
    const p = await createPost(bob, s, g.key, blob.blobId, content);
    expect((await bob.api.postRecords(g.group, [p.envelope])).results[0]!.status).toBe("ok");

    await sync.runOnce();
    // 学外のアリスが、学内で撮った動画を CF から取得して復号できる
    const got = (await allRecords(alice.api, g.group)).find((r) => r.id === p.id)!;
    const opened = await openContent<PostContent>(g.key, got.header);
    expect(await decryptBlob(opened.ck, await alice.api.downloadBlob(blob.blobId), blob.blobId)).toEqual(video);
    expect(await snapshot(alice.api, g.group)).toEqual(await snapshot(bob.api, g.group));
  });

  it("keeps working on campus while CF is down and merges afterwards", async () => {
    const { cf, campus, sync } = await setup();
    const alice = await newDevice(cf);
    const bob = await newDevice(campus);
    const carol = await newDevice(campus);
    const g = await createGroup(alice, { name: "procon" });
    await alice.api.postRecords(g.group, g.records.map((r) => r.envelope));
    const { record: inv, token } = await createInvite(alice, await deriveGroupState(g.group, g.records));
    await alice.api.postRecords(g.group, [inv.envelope]);
    await sync.runOnce();
    await bob.api.postRecords(g.group, [(await joinGroup(bob, g.group, inv.id, token)).envelope]);
    await sync.runOnce();

    // CF 障害
    cf.state.down = true;
    await expect(sync.runOnce()).rejects.toThrow();

    // 学内だけで招待・参加・投稿ができる
    let s = await deriveGroupState(g.group, await allRecords(bob.api, g.group));
    const inv2 = await createInvite(bob, s);
    await bob.api.postRecords(g.group, [inv2.record.envelope]);
    const cj = await joinGroup(carol, g.group, inv2.record.id, inv2.token);
    expect((await carol.api.postRecords(g.group, [cj.envelope])).results[0]!.status).toBe("ok");
    s = await deriveGroupState(g.group, await allRecords(carol.api, g.group));
    const blob = await encryptBlob(randomBytes(512));
    await carol.api.uploadBlob(g.group, blob.blobId, blob.sealed);
    const p = await createPost(carol, s, g.key, blob.blobId, { ck: blob.ck, mime: "video/mp4", durationMs: 3000, takenAt: Date.now() });
    expect((await carol.api.postRecords(g.group, [p.envelope])).results[0]!.status).toBe("ok");

    // 分断中に学外では管理者がボブに移譲、学内ではボブが退会（競合）
    cf.state.down = false; // 学外の端末からは CF に届く（落ちているのは学内→CF の経路という想定）
    const sCf = await deriveGroupState(g.group, await allRecords(alice.api, g.group));
    await alice.api.postRecords(g.group, [(await transferAdmin(alice, sCf, bob.signer.pub)).envelope]);
    cf.state.down = true;
    const sCampus = await deriveGroupState(g.group, await allRecords(bob.api, g.group));
    await bob.api.postRecords(g.group, [(await leaveGroup(bob, sCampus)).envelope]);

    // 復旧すると合流し、両側の導出結果が一致する
    cf.state.down = false;
    await sync.runOnce();
    expect((await allRecords(alice.api, g.group)).some((r) => r.id === p.id)).toBe(true);
    const a = await snapshot(alice.api, g.group);
    expect(a).toEqual(await snapshot(carol.api, g.group));
    expect(a.members).toContain(carol.signer.pub);
    expect(await alice.api.downloadBlob(blob.blobId)).toEqual(blob.sealed);
  });

  it("sends the hourly prompt once across peers", async () => {
    const { cf, campus, sync, cfPush, campusPush } = await setup();
    const alice = await newDevice(cf);
    const g = await createGroup(alice, { name: "procon" });
    await alice.api.postRecords(g.group, g.records.map((r) => r.envelope));
    await alice.api.pushSubscribe({ endpoint: "https://push.example/a", keys: { p256dh: "x", auth: "y" } });
    await sync.runOnce();

    // 活動時間帯に関係なく送れるよう、全時間帯を有効にする
    await cf.deps.sql.run("UPDATE groups SET hours_start = 0, hours_end = 24");
    await campus.deps.sql.run("UPDATE groups SET hours_start = 0, hours_end = 24");

    expect((await runHourlyPrompt(cf.deps, cf.store)).sent).toBe(1);
    await sync.runOnce();
    expect(await runHourlyPrompt(campus.deps, campus.store)).toMatchObject({ skipped: "slot already sent" });
    expect(cfPush.sent).toHaveLength(1);
    expect(campusPush.sent).toHaveLength(0);
  });

  it("fails over the hourly prompt to campus when CF did not send", async () => {
    const { cf, campus, sync, campusPush } = await setup();
    const alice = await newDevice(cf);
    const g = await createGroup(alice, { name: "procon" });
    await alice.api.postRecords(g.group, g.records.map((r) => r.envelope));
    await alice.api.pushSubscribe({ endpoint: "https://push.example/a", keys: { p256dh: "x", auth: "y" } });
    await sync.runOnce();
    await campus.deps.sql.run("UPDATE groups SET hours_start = 0, hours_end = 24");
    cf.state.down = true;
    expect((await runHourlyPrompt(campus.deps, campus.store)).sent).toBe(1);
    expect(campusPush.sent).toHaveLength(1);
    // 復旧後、CF はスロットを受け取っているので送らない
    cf.state.down = false;
    await sync.runOnce();
    await cf.deps.sql.run("UPDATE groups SET hours_start = 0, hours_end = 24");
    expect(await runHourlyPrompt(cf.deps, cf.store)).toMatchObject({ skipped: "slot already sent" });
  });
});

describe("peer database reset", () => {
  it("resends everything when CF's database is recreated", async () => {
    const key = await generatePeerKey();
    let cf = inProcessServer("cf", { peerKeys: [key.publicKey] });
    const campus = inProcessServer("campus");
    // ワーカーは同じ URL に話しかけ続けるが、向こう側の DB が入れ替わる
    const sync = new SyncWorker(cf.baseUrl, await peerSigner(key.privatePkcs8), campus.deps, campus.store, (i, init) => cf.fetch(i, init));
    const alice = await newDevice(cf);
    const g = await createGroup(alice, { name: "procon" });
    await alice.api.postRecords(g.group, g.records.map((r) => r.envelope));
    await sync.runOnce();
    for (let i = 0; i < 3; i++) await createGroup(alice, { name: `filler${i}` }).then((x) => alice.api.postRecords(x.group, x.records.map((r) => r.envelope)));
    await sync.runOnce();

    cf = inProcessServer("cf", { peerKeys: [key.publicKey] }); // D1 を作り直した
    const alice2 = await newDevice(cf);
    const h = await createGroup(alice2, { name: "after reset" });
    await alice2.api.postRecords(h.group, h.records.map((r) => r.envelope));
    await sync.runOnce();

    // 学内は新しい CF のデータを取り込めている（古いカーソルで取りこぼしていない）
    expect((await campus.store.controlRecords(h.group)).length).toBeGreaterThan(0);
    // 新しい CF には学内から元のグループが送り直されている
    expect((await cf.store.controlRecords(g.group)).length).toBe(2);
  });
  it("replicates account docs both ways, newest wins", async () => {
    const { cf, campus, sync } = await setup();
    const secret = await generateAccountSecret("たくま");
    const keys = await importAccountKeys(secret);
    const signer = cryptoKeySigner(keys.signPub, keys.sign.privateKey);
    const amk = newAmk();
    const base: AccountDoc = { v: 1, account: secret.signPub, ts: 1000, bundle: await sealBundle(amk, secret), unlocks: [] };
    const atCampus = new ApiClient(campus.baseUrl, signer, campus.fetch);
    const atCf = new ApiClient(cf.baseUrl, signer, cf.fetch);

    // 学内で作ったアカウントを、学外の新しい端末が CF から取得できる
    await atCampus.putAccount(await signAccountDoc(signer, base));
    expect(await atCf.getAccount(secret.signPub)).toBeNull();
    await sync.runOnce();
    expect((await openAccountDoc(await atCf.getAccount(secret.signPub)))).toMatchObject({ ts: 1000 });

    // CF 側でパスキーを追加 → 学内に戻る。学内の古い文書では上書きされない
    const unlock = await makeUnlock(amk, secret.signPub, "passkey", "Y3JlZA", await deriveKek(randomBytes(32), "passkey"));
    await atCf.putAccount(await signAccountDoc(signer, { ...base, ts: 2000, unlocks: [unlock] }));
    await sync.runOnce();
    await sync.runOnce();
    for (const api of [atCampus, atCf]) {
      expect((await openAccountDoc(await api.getAccount(secret.signPub))).unlocks.map((u) => u.id)).toEqual(["Y3JlZA"]);
    }
  });
});
