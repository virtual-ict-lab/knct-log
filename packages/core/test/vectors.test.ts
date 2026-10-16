import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveGroupState, deriveKek, fromB64u, importAccountKeys, openAccountDoc, openBundle, openContent, openRecord, openUnlock, toB64u } from "../src/index.ts";

const vec = JSON.parse(readFileSync(new URL("../../../protocol/test-vectors/group-basic.json", import.meta.url), "utf8"));

describe("test vectors", () => {
  it("verifies ids, signatures and derived state", async () => {
    const recs = [];
    for (const r of vec.records) {
      const v = await openRecord(r.envelope);
      expect(v.id).toBe(r.id);
      expect(v.header.kind).toBe(r.kind);
      recs.push(v);
    }
    const s = await deriveGroupState(recs[0]!.header.group, recs);
    expect({
      admin: s.admin,
      members: [...s.members.keys()].sort(),
      currentEpoch: s.currentEpoch,
      applied: [...s.applied].sort(),
    }).toEqual(vec.expected);
  });
});

const acc = JSON.parse(readFileSync(new URL("../../../protocol/test-vectors/account-and-reactions.json", import.meta.url), "utf8"));

describe("account and reaction vectors", () => {
  it("opens the account doc with the PRF output and the link secret", async () => {
    const doc = await openAccountDoc(acc.account.envelope);
    const e = acc.account.expected;
    expect(toB64u(await deriveKek(fromB64u(acc.account.prf), "passkey"))).toBe(e.kekPasskey);
    expect(toB64u(await deriveKek(fromB64u(acc.account.linkSecret), "link"))).toBe(e.kekLink);
    for (const [u, kek] of [[doc.unlocks[0]!, e.kekPasskey], [doc.unlocks[1]!, e.kekLink]] as const) {
      expect(toB64u(await openUnlock(doc, u, fromB64u(kek)))).toBe(e.amk);
    }
    const secret = await openBundle(fromB64u(e.amk), doc);
    expect(secret.name).toBe(e.name);
    const keys = await importAccountKeys(secret);
    expect([keys.signPub, keys.kxPub, doc.account]).toEqual([e.signPub, e.kxPub, e.signPub]);
  });

  it("decrypts post text, reactions and replies", async () => {
    const key = fromB64u(acc.groupKey);
    for (const r of acc.records) {
      const v = await openRecord(r.envelope);
      expect(v.id).toBe(r.id);
      if (acc.contents[r.id]) expect(await openContent(key, v.header)).toEqual(acc.contents[r.id]);
    }
  });
});
