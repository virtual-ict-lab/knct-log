import { describe, expect, it } from "vitest";
import { createGroup, createInvite, createPost, createReaction, createReply, deriveGroupState, encryptBlob, joinGroup, randomBytes } from "@knct-log/core";
import { allRecords, newDevice } from "@knct-log/conformance";
import { countingPusher, inProcessServer } from "./helpers.ts";

describe("notifications", () => {
  it("sends reactions and replies only to the post's author", async () => {
    const { pusher, sent } = countingPusher();
    const deferred: Promise<unknown>[] = [];
    const server = inProcessServer("campus", { pusher });
    server.deps.defer = (p) => void deferred.push(p);
    const [alice, bob, carol] = await Promise.all([newDevice(server), newDevice(server), newDevice(server)]);

    const g = await createGroup(alice, { name: "g" });
    await alice.api.postRecords(g.group, g.records.map((r) => r.envelope));
    const { record: inv, token } = await createInvite(alice, await deriveGroupState(g.group, g.records));
    await alice.api.postRecords(g.group, [inv.envelope]);
    for (const d of [bob, carol]) await d.api.postRecords(g.group, [(await joinGroup(d, g.group, inv.id, token)).envelope]);
    for (const [d, n] of [[alice, "a"], [bob, "b"], [carol, "c"]] as const)
      await d.api.pushSubscribe({ endpoint: `https://push.test/${n}`, keys: { p256dh: "p", auth: "a" } });

    const s = await deriveGroupState(g.group, await allRecords(alice.api, g.group));
    const blob = await encryptBlob(randomBytes(100));
    await alice.api.uploadBlob(g.group, blob.blobId, blob.sealed);
    const post = await createPost(alice, s, g.key, blob.blobId, { ck: blob.ck, mime: "video/mp4", durationMs: 3000, takenAt: Date.now() });
    await alice.api.postRecords(g.group, [post.envelope]);
    await Promise.all(deferred);
    sent.length = 0;

    const ref = { id: post.id, author: alice.signer.pub, exp: post.header.exp! };
    await bob.api.postRecords(g.group, [(await createReaction(bob, s, g.key, ref, "🔥")).envelope]);
    await carol.api.postRecords(g.group, [(await createReply(carol, s, g.key, ref, "いいね")).envelope]);
    await alice.api.postRecords(g.group, [(await createReaction(alice, s, g.key, ref, "❤️")).envelope]); // 自分の投稿には通知しない
    await Promise.all(deferred);
    expect(sent).toEqual([
      { endpoint: "https://push.test/a", payload: { t: "reaction", g: g.group } },
      { endpoint: "https://push.test/a", payload: { t: "reply", g: g.group } },
    ]);
  });
});
