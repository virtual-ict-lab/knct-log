import { describe, expect, it } from "vitest";
import { randomBytes, toB64u, utf8 } from "../src/bytes.ts";
import { sign, verify, unwrapGroupKey, wrapGroupKey } from "../src/crypto.ts";
import {
  type AccountDoc,
  deriveKek,
  generateAccountSecret,
  importAccountKeys,
  makeUnlock,
  newAmk,
  openAccountDoc,
  openBundle,
  openUnlock,
  sealBundle,
  signAccountDoc,
  withUnlock,
} from "../src/account.ts";
import { cryptoKeySigner, openRecord } from "../src/record.ts";
import { createGroup, createPost, createReaction, createReply, openContent } from "../src/ops.ts";
import { deriveGroupState } from "../src/membership.ts";
import { newActor } from "./helpers.ts";

async function newAccount() {
  const secret = await generateAccountSecret("たくま");
  const keys = await importAccountKeys(secret);
  const amk = newAmk();
  const prf = randomBytes(32);
  const credId = toB64u(randomBytes(16));
  const doc: AccountDoc = {
    v: 1,
    account: secret.signPub,
    ts: Date.now(),
    bundle: await sealBundle(amk, secret),
    unlocks: [await makeUnlock(amk, secret.signPub, "passkey", credId, await deriveKek(prf, "passkey"))],
  };
  const signer = cryptoKeySigner(keys.signPub, keys.sign.privateKey);
  return { secret, keys, amk, prf, credId, doc, signer };
}

describe("account", () => {
  it("restores the same keys on another device from the passkey PRF output", async () => {
    const a = await newAccount();
    const env = await signAccountDoc(a.signer, a.doc);

    // 新しい端末：サーバーから文書を取り、同じパスキーの PRF 出力で開ける
    const doc = await openAccountDoc(env);
    const u = doc.unlocks.find((x) => x.id === a.credId)!;
    const amk = await openUnlock(doc, u, await deriveKek(a.prf, "passkey"));
    const secret = await openBundle(amk, doc);
    expect(secret.name).toBe("たくま");
    const keys = await importAccountKeys(secret);
    expect(keys.signPub).toBe(a.keys.signPub);

    // 署名が元の公開鍵で検証でき、元の端末宛ての wrap を解ける（＝グループに入り直す必要がない）
    const msg = utf8.encode("hello");
    expect(await verify(a.keys.signPub, msg, await sign(keys.sign.privateKey, msg))).toBe(true);
    const gk = randomBytes(32);
    const w = await wrapGroupKey(a.keys.kxPub, gk, "g", "e");
    expect(await unwrapGroupKey(keys.kx, w, "g", "e")).toEqual(gk);

    // 秘密鍵は取り出せない
    await expect(crypto.subtle.exportKey("pkcs8", keys.sign.privateKey)).rejects.toThrow();
  });

  it("rejects a wrong PRF output, a tampered doc and a doc signed by someone else", async () => {
    const a = await newAccount();
    const u = a.doc.unlocks[0]!;
    await expect(openUnlock(a.doc, u, await deriveKek(randomBytes(32), "passkey"))).rejects.toThrow();
    // passkey 用の KEK を link として使っても開けない（用途ごとに導出が違う）
    await expect(openUnlock(a.doc, u, await deriveKek(a.prf, "link"))).rejects.toThrow();

    const env = await signAccountDoc(a.signer, a.doc);
    const tampered = { ...env, payload: toB64u(utf8.encode(JSON.stringify({ ...a.doc, ts: a.doc.ts + 1 }))) };
    await expect(openAccountDoc(tampered)).rejects.toThrow("bad signature");

    const b = await newAccount();
    await expect(signAccountDoc(b.signer, a.doc)).rejects.toThrow();
  });

  it("adds a time-limited link unlock and drops expired ones", async () => {
    const a = await newAccount();
    const linkSecret = randomBytes(32);
    const link = await makeUnlock(a.amk, a.doc.account, "link", "L1", await deriveKek(linkSecret, "link"), 1000);
    const unlocks = withUnlock(a.doc, link, undefined, 500);
    expect(unlocks.map((u) => u.kind)).toEqual(["passkey", "link"]);
    const doc = { ...a.doc, unlocks };
    expect(await openUnlock(doc, link, await deriveKek(linkSecret, "link"))).toEqual(a.amk);
    expect(withUnlock(doc, null, undefined, 2000).map((u) => u.kind)).toEqual(["passkey"]);
    expect(withUnlock(doc, null, "L1", 500).map((u) => u.kind)).toEqual(["passkey"]);
  });
});

describe("reactions and replies", () => {
  it("are encrypted, expire with the post and name only the post author in clear", async () => {
    const alice = await newActor();
    const bob = await newActor();
    const g = await createGroup(alice, { name: "g" });
    const s = await deriveGroupState(g.group, g.records);
    const post = await createPost(alice, s, g.key, toB64u(randomBytes(32)), {
      ck: toB64u(randomBytes(32)),
      mime: "video/mp4",
      durationMs: 3000,
      takenAt: Date.now(),
      text: "おはよう",
    });
    expect((await openContent<{ text: string }>(g.key, post.header)).text).toBe("おはよう");

    const ref = { id: post.id, author: alice.signer.pub, exp: post.header.exp! };
    const react = await createReaction(bob, s, g.key, ref, "🔥");
    const reply = await createReply(bob, s, g.key, ref, "いいね");
    for (const r of [react, reply]) {
      const opened = await openRecord(r.envelope);
      expect(opened.header.exp).toBe(post.header.exp);
      expect(opened.header.body).toEqual({ to: alice.signer.pub });
      expect(opened.envelope.payload).not.toContain(post.id);
    }
    expect(await openContent(g.key, react.header)).toEqual({ ref: post.id, emoji: "🔥" });
    expect(await openContent(g.key, reply.header)).toEqual({ ref: post.id, text: "いいね" });
    await expect(createReply(bob, s, g.key, ref, "あ".repeat(201))).rejects.toThrow();
  });
});
