import { describe, expect, it } from "vitest";
import { aeadOpen, aeadSeal, generateDeviceKeys, sign, unwrapGroupKey, verify, wrapGroupKey } from "../src/crypto.ts";
import { randomBytes, utf8 } from "../src/bytes.ts";

describe("crypto", () => {
  it("signs and verifies with Ed25519", async () => {
    const k = await generateDeviceKeys();
    const msg = utf8.encode("hello");
    const sig = await sign(k.sign.privateKey, msg);
    expect(await verify(k.signPub, msg, sig)).toBe(true);
    expect(await verify(k.signPub, utf8.encode("hellO"), sig)).toBe(false);
  });

  it("wraps group keys with HPKE to a non-extractable X25519 key", async () => {
    const k = await generateDeviceKeys();
    const gk = randomBytes(32);
    const w = await wrapGroupKey(k.kxPub, gk, "g1", "e1");
    expect(await unwrapGroupKey(k.kx, w, "g1", "e1")).toEqual(gk);
    await expect(unwrapGroupKey(k.kx, w, "g1", "e2")).rejects.toThrow();
  });

  it("seals with AES-GCM and binds AAD", async () => {
    const key = randomBytes(32);
    const sealed = await aeadSeal(key, utf8.encode("secret"), utf8.encode("aad"));
    expect(utf8.decode(await aeadOpen(key, sealed, utf8.encode("aad")))).toBe("secret");
    await expect(aeadOpen(key, sealed, utf8.encode("other"))).rejects.toThrow();
  });
});
