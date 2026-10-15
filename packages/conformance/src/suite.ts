import { describe, expect, it } from "vitest";
import {
  ApiClient,
  ApiError,
  type Actor,
  type PostContent,
  createGroup,
  createInvite,
  createPost,
  cryptoKeySigner,
  decryptBlob,
  deriveGroupState,
  encryptBlob,
  generateDeviceKeys,
  joinGroup,
  leaveGroup,
  openContent,
  openRecord,
  randomBytes,
  transferAdmin,
  type VerifiedRecord,
} from "@knct-log/core";

export interface Target {
  baseUrl: string;
  fetch?: typeof fetch;
}

export interface Device extends Actor {
  kx: CryptoKeyPair;
  api: ApiClient;
}

export async function newDevice(t: Target): Promise<Device> {
  const k = await generateDeviceKeys();
  const signer = cryptoKeySigner(k.signPub, k.sign.privateKey);
  return { signer, kxPub: k.kxPub, kx: k.kx, api: new ApiClient(t.baseUrl, signer, t.fetch) };
}

export async function allRecords(api: ApiClient, group: string): Promise<VerifiedRecord[]> {
  const out: VerifiedRecord[] = [];
  let after = 0;
  for (;;) {
    const page = await api.getRecords(group, after);
    for (const env of page.records) out.push(await openRecord(env));
    after = page.next;
    if (!page.more) return out;
  }
}

async function post(api: ApiClient, group: string, ...recs: VerifiedRecord[]) {
  return (await api.postRecords(group, recs.map((r) => r.envelope))).results;
}

/** 両サーバー実装が満たすべき API の振る舞い */
export function conformance(name: string, target: () => Target) {
  describe(`conformance: ${name}`, () => {
    it("reports health", async () => {
      const t = target();
      const res = await (t.fetch ?? fetch)(`${t.baseUrl}/v1/health`);
      expect(res.status).toBe(200);
      expect(typeof (await res.json()).server_id).toBe("string");
    });

    it("rejects requests without a token", async () => {
      const t = target();
      const res = await (t.fetch ?? fetch)(`${t.baseUrl}/v1/me/groups`);
      expect(res.status).toBe(401);
    });

    it("rejects a token request with a bad signature", async () => {
      const t = target();
      const f = t.fetch ?? fetch;
      const { challenge } = await (await f(`${t.baseUrl}/v1/auth/challenge`, { method: "POST" })).json();
      const a = await newDevice(t);
      const res = await f(`${t.baseUrl}/v1/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pk: a.signer.pub, challenge, sig: "A".repeat(86) }),
      });
      expect(res.status).toBe(401);
    });

    it("runs the full group lifecycle", async () => {
      const t = target();
      const [alice, bob, carol, mallory] = await Promise.all([newDevice(t), newDevice(t), newDevice(t), newDevice(t)]);

      // 作成
      const g = await createGroup(alice, { name: "procon" });
      expect((await post(alice.api, g.group, ...g.records)).map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
      expect((await post(alice.api, g.group, g.records[0]!))[0]!.status).toBe("dup");
      expect((await alice.api.myGroups()).groups.map((x) => x.group)).toContain(g.group);

      // 非メンバーは読めない
      await expect(mallory.api.getRecords(g.group)).rejects.toMatchObject({ status: 403 });

      // 招待と参加
      let s = await deriveGroupState(g.group, await allRecords(alice.api, g.group));
      const { record: inv, token } = await createInvite(alice, s);
      const earlyJoin = await joinGroup(bob, g.group, inv.id, token);
      expect((await post(bob.api, g.group, earlyJoin))[0]).toMatchObject({ status: "missing", missing: [inv.id] });
      expect((await post(alice.api, g.group, inv))[0]!.status).toBe("ok");
      const badJoin = await joinGroup(mallory, g.group, inv.id, "A".repeat(43));
      expect((await post(mallory.api, g.group, badJoin))[0]).toMatchObject({ status: "invalid" });
      expect((await post(bob.api, g.group, earlyJoin))[0]!.status).toBe("ok");
      const join2 = await joinGroup(carol, g.group, inv.id, token);
      expect((await post(carol.api, g.group, join2))[0]!.status).toBe("ok");

      // 他人名義のレコードは送れない
      expect((await post(mallory.api, g.group, inv))[0]).toMatchObject({ status: "invalid" });

      // 投稿：blob が先に必要
      s = await deriveGroupState(g.group, await allRecords(bob.api, g.group));
      const video = randomBytes(4096);
      const blob = await encryptBlob(video);
      const content: PostContent = { ck: blob.ck, mime: "video/mp4", durationMs: 3000, takenAt: Date.now() };
      const p = await createPost(bob, s, g.key, blob.blobId, content);
      expect((await post(bob.api, g.group, p))[0]).toMatchObject({ status: "missing", missing: [`blob:${blob.blobId}`] });
      await expect(mallory.api.uploadBlob(g.group, blob.blobId, blob.sealed)).rejects.toMatchObject({ status: 403 });
      await bob.api.uploadBlob(g.group, blob.blobId, blob.sealed);
      expect((await post(bob.api, g.group, p))[0]!.status).toBe("ok");

      // 別メンバーが受信・復号できる
      const recs = await allRecords(alice.api, g.group);
      const got = recs.find((r) => r.id === p.id)!;
      const opened = await openContent<PostContent>(g.key, got.header);
      expect(await decryptBlob(opened.ck, await alice.api.downloadBlob(blob.blobId), blob.blobId)).toEqual(video);
      await expect(mallory.api.downloadBlob(blob.blobId)).rejects.toMatchObject({ status: 403 });

      // 管理者の移譲：管理者以外は不可
      s = await deriveGroupState(g.group, recs);
      const fake = await transferAdmin(bob, s, carol.signer.pub);
      expect((await post(bob.api, g.group, fake))[0]).toMatchObject({ status: "invalid" });
      const xfer = await transferAdmin(alice, s, bob.signer.pub);
      expect((await post(alice.api, g.group, xfer))[0]!.status).toBe("ok");
      expect((await alice.api.myGroups()).groups.find((x) => x.group === g.group)!.admin).toBe(bob.signer.pub);

      // 退会：本人のみ。退会後は読めない
      s = await deriveGroupState(g.group, await allRecords(alice.api, g.group));
      const leave = await leaveGroup(carol, s);
      expect((await post(carol.api, g.group, leave))[0]!.status).toBe("ok");
      await expect(carol.api.getRecords(g.group)).rejects.toMatchObject({ status: 403 });

      // 管理者は後継者なしでは退会できない
      s = await deriveGroupState(g.group, await allRecords(alice.api, g.group));
      const adminLeave = await leaveGroup(bob, s);
      expect((await post(bob.api, g.group, adminLeave))[0]).toMatchObject({ status: "invalid" });
    });

    it("forbids peer endpoints to ordinary devices", async () => {
      const a = await newDevice(target());
      await expect(a.api.peerRecords()).rejects.toBeInstanceOf(ApiError);
    });
  });
}
