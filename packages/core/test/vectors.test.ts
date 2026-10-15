import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveGroupState, openRecord } from "../src/index.ts";

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
    const s = await deriveGroupState(recs[0].header.group, recs);
    expect({
      admin: s.admin,
      members: [...s.members.keys()].sort(),
      currentEpoch: s.currentEpoch,
      applied: [...s.applied].sort(),
    }).toEqual(vec.expected);
  });
});
