import { describe, expect, it } from "vitest";
import { admitContent, admitControl, deriveGroupState, type GroupState } from "../src/membership.ts";
import {
  createGroup,
  createInvite,
  createPost,
  encryptBlob,
  joinGroup,
  leaveGroup,
  openContent,
  rotateKey,
  transferAdmin,
  decryptBlob,
  type PostContent,
} from "../src/ops.ts";
import { unwrapGroupKey } from "../src/crypto.ts";
import { MAX_MEMBERS, openRecord, type VerifiedRecord } from "../src/record.ts";
import { randomBytes, utf8 } from "../src/bytes.ts";
import { newActor, shuffle } from "./helpers.ts";

async function setup(n: number) {
  const actors = await Promise.all(Array.from({ length: n }, newActor));
  const admin = actors[0]!;
  const g = await createGroup(admin, { name: "procon" });
  const log: VerifiedRecord[] = [...g.records];
  const state = () => deriveGroupState(g.group, log);
  for (const a of actors.slice(1)) {
    const { record: inv, token } = await createInvite(admin, await state());
    log.push(inv);
    log.push(await joinGroup(a, g.group, inv.id, token));
  }
  return { actors, admin, g, log, state };
}

function summary(s: GroupState) {
  return {
    admin: s.admin,
    members: [...s.members.keys()].sort(),
    epoch: s.currentEpoch,
    applied: [...s.applied].sort(),
    rejected: [...s.rejected.keys()].sort(),
    uncovered: s.uncoveredLeaves,
    heads: s.heads,
  };
}

describe("membership", () => {
  it("creates a group with the creator as admin", async () => {
    const { admin, state, g } = await setup(1);
    const s = await state();
    expect(s.admin).toBe(admin.signer.pub);
    expect([...s.members.keys()]).toEqual([admin.signer.pub]);
    expect(s.currentEpoch).toBe(g.epoch);
  });

  it("lets invited members join and rejects a wrong token", async () => {
    const { actors, state, log, g, admin } = await setup(2);
    expect((await state()).members.has(actors[1]!.signer.pub)).toBe(true);
    const intruder = await newActor();
    const { record: inv } = await createInvite(admin, await state());
    log.push(inv);
    const bad = await joinGroup(intruder, g.group, inv.id, "A".repeat(43));
    expect(await admitControl(g.group, log, bad)).toEqual({ ok: false, reason: "invalid invite token" });
  });

  it("only lets members leave themselves (no removal of others exists)", async () => {
    const { actors, state, log } = await setup(3);
    const leave = await leaveGroup(actors[2]!, await state());
    log.push(leave);
    const s = await state();
    expect(s.members.has(actors[2]!.signer.pub)).toBe(false);
    expect(s.uncoveredLeaves).toEqual([leave.id]);
  });

  it("requires the admin to name a successor when leaving", async () => {
    const { admin, actors, state, g, log } = await setup(2);
    const noSucc = await leaveGroup(admin, await state());
    expect(await admitControl(g.group, log, noSucc)).toMatchObject({ ok: false });
    const withSucc = await leaveGroup(admin, await state(), actors[1]!.signer.pub);
    log.push(withSucc);
    expect((await state()).admin).toBe(actors[1]!.signer.pub);
  });

  it("transfers admin only from the current admin", async () => {
    const { admin, actors, state, g, log } = await setup(3);
    const fake = await transferAdmin(actors[1]!, await state(), actors[2]!.signer.pub);
    expect(await admitControl(g.group, log, fake)).toEqual({ ok: false, reason: "only admin can transfer" });
    log.push(await transferAdmin(admin, await state(), actors[1]!.signer.pub));
    expect((await state()).admin).toBe(actors[1]!.signer.pub);
    // 元管理者はもう移譲できない
    const again = await transferAdmin(admin, await state(), actors[2]!.signer.pub);
    expect(await admitControl(g.group, log, again)).toEqual({ ok: false, reason: "only admin can transfer" });
  });

  it("dissolves when the last member leaves", async () => {
    const { admin, state, log } = await setup(1);
    log.push(await leaveGroup(admin, await state()));
    expect((await state()).dissolved).toBe(true);
  });

  it("rotation after a leave excludes the leaver and covers the leave", async () => {
    const { actors, state, log, g } = await setup(3);
    const leaver = actors[2]!;
    log.push(await leaveGroup(leaver, await state()));
    const rot = await rotateKey(actors[1]!, await state());
    log.push(...rot.records);
    const s = await state();
    expect(s.currentEpoch).toBe(rot.epoch);
    expect(s.uncoveredLeaves).toEqual([]);
    const wrapTargets = rot.records.slice(1).map((r) => r.header.body!.to);
    expect(wrapTargets).not.toContain(leaver.signer.pub);
    // 残ったメンバーは新しい鍵を取り出せる
    const w = rot.records.find((r) => r.header.body?.to === actors[0]!.signer.pub)!;
    const k = await unwrapGroupKey(actors[0]!.kx, w.header.body as { enc: string; ct: string }, g.group, rot.epoch);
    expect(k).toEqual(rot.key);
  });

  it("resolves concurrent rotations deterministically", async () => {
    const { actors, state, log } = await setup(3);
    log.push(await leaveGroup(actors[2]!, await state()));
    const s0 = await state();
    const r1 = await rotateKey(actors[0]!, s0);
    const r2 = await rotateKey(actors[1]!, s0);
    log.push(...r1.records, ...r2.records);
    const s = await state();
    expect(s.currentEpoch).toBe([r1.epoch, r2.epoch].sort()[0]);
    expect(s.uncoveredLeaves).toEqual([]);
  });

  it("caps membership at MAX_MEMBERS", async () => {
    const { admin, state, g, log } = await setup(MAX_MEMBERS);
    const { record: inv, token } = await createInvite(admin, await state());
    log.push(inv);
    const extra = await newActor();
    const join = await joinGroup(extra, g.group, inv.id, token);
    expect(await admitControl(g.group, log, join)).toEqual({ ok: false, reason: "group is full" });
  });

  it("derives the same state regardless of arrival order", async () => {
    const { actors, admin, state, log } = await setup(4);
    log.push(await transferAdmin(admin, await state(), actors[1]!.signer.pub));
    log.push(await leaveGroup(actors[3]!, await state()));
    log.push(...(await rotateKey(actors[2]!, await state())).records);
    log.push(await leaveGroup(actors[1]!, await state(), actors[2]!.signer.pub));
    const expected = summary(await state());
    for (let seed = 1; seed <= 20; seed++) {
      const s = await deriveGroupState(log[0]!.header.group, shuffle(log, seed));
      expect(summary(s)).toEqual(expected);
    }
  });

  it("marks records with missing deps as pending", async () => {
    const { admin, state, g, log } = await setup(1);
    const { record: inv, token } = await createInvite(admin, await state());
    const join = await joinGroup(await newActor(), g.group, inv.id, token);
    const res = await admitControl(g.group, log, join);
    expect(res).toEqual({ ok: false, missing: [inv.id] });
  });

  it("encrypts posts end to end and admits only members", async () => {
    const { actors, state, g } = await setup(2);
    const s = await state();
    const video = randomBytes(1000);
    const blob = await encryptBlob(video);
    const content: PostContent = { ck: blob.ck, mime: "video/mp4", durationMs: 3000, takenAt: Date.now() };
    const post = await createPost(actors[1]!, s, g.key, blob.blobId, content);
    expect(admitContent(s, post.header)).toEqual({ ok: true });
    const received = await openRecord(post.envelope);
    const opened = await openContent<PostContent>(g.key, received.header);
    expect(await decryptBlob(opened.ck, blob.sealed, blob.blobId)).toEqual(video);
    // 平文がペイロードに含まれない
    expect(utf8.decode(new TextEncoder().encode(post.envelope.payload))).not.toContain(blob.ck);
    const outsider = await newActor();
    const fake = await createPost(outsider, s, g.key, blob.blobId, content);
    expect(admitContent(s, fake.header)).toEqual({ ok: false, reason: "not a member" });
  });

  it("rejects tampered envelopes", async () => {
    const { g } = await setup(1);
    const env = g.records[0]!.envelope;
    const bad = { ...env, payload: env.payload.slice(0, -2) + (env.payload.endsWith("A") ? "BB" : "AA") };
    await expect(openRecord(bad)).rejects.toThrow();
  });
});
