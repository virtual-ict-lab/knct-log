// 実際に起動した CF（wrangler dev）と学内サーバーの間の同期を確かめる。
//   CF_URL=http://127.0.0.1:8787 CAMPUS_URL=http://127.0.0.1:3000 pnpm vitest run test/e2e-sync.test.ts
import { describe, expect, it } from "vitest";
import {
  ApiClient,
  type PostContent,
  cryptoKeySigner,
  generateAccountSecret,
  importAccountKeys,
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
  openContent,
  randomBytes,
} from "@knct-log/core";
import { allRecords, newDevice } from "../src/suite.ts";

const cfUrl = process.env.CF_URL;
const campusUrl = process.env.CAMPUS_URL;

async function eventually<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe.skipIf(!cfUrl || !campusUrl)("e2e sync (live servers)", () => {
  it("delivers a campus post to an off-campus member via CF", { timeout: 90_000 }, async () => {
    const alice = await newDevice({ baseUrl: cfUrl! });
    const bob = await newDevice({ baseUrl: campusUrl! });
    const g = await createGroup(alice, { name: "e2e" });
    await alice.api.postRecords(g.group, g.records.map((r) => r.envelope));
    const { record: inv, token } = await createInvite(alice, await deriveGroupState(g.group, g.records));
    await alice.api.postRecords(g.group, [inv.envelope]);

    const join = await joinGroup(bob, g.group, inv.id, token);
    const joined = await eventually(
      async () => (await bob.api.postRecords(g.group, [join.envelope])).results[0]!.status,
      (s) => s === "ok" || s === "dup",
    );
    expect(["ok", "dup"]).toContain(joined);

    const s = await deriveGroupState(g.group, await allRecords(bob.api, g.group));
    const video = randomBytes(64 * 1024);
    const blob = await encryptBlob(video);
    await bob.api.uploadBlob(g.group, blob.blobId, blob.sealed);
    const content: PostContent = { ck: blob.ck, mime: "video/mp4", durationMs: 3000, takenAt: Date.now() };
    const p = await createPost(bob, s, g.key, blob.blobId, content);
    expect((await bob.api.postRecords(g.group, [p.envelope])).results[0]!.status).toBe("ok");

    const recs = await eventually(() => allRecords(alice.api, g.group), (rs) => rs.some((r) => r.id === p.id));
    const got = recs.find((r) => r.id === p.id)!;
    const opened = await openContent<PostContent>(g.key, got.header);
    expect(await decryptBlob(opened.ck, await alice.api.downloadBlob(blob.blobId), blob.blobId)).toEqual(video);
  });

  it("makes an account created on campus available off campus", { timeout: 60_000 }, async () => {
    const secret = await generateAccountSecret("学内で作った人");
    const keys = await importAccountKeys(secret);
    const signer = cryptoKeySigner(keys.signPub, keys.sign.privateKey);
    const doc = { v: 1 as const, account: secret.signPub, ts: Date.now(), bundle: await sealBundle(newAmk(), secret), unlocks: [] };
    await new ApiClient(campusUrl!, signer).putAccount(await signAccountDoc(signer, doc));
    const atCf = new ApiClient(cfUrl!, signer);
    const got = await eventually(() => atCf.getAccount(secret.signPub), (e) => e !== null);
    expect((await openAccountDoc(got)).ts).toBe(doc.ts);
  });
});
