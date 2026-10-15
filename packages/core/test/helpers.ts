import { generateDeviceKeys } from "../src/crypto.ts";
import { cryptoKeySigner } from "../src/record.ts";
import type { Actor } from "../src/ops.ts";

export async function newActor(): Promise<Actor & { kx: CryptoKeyPair }> {
  const k = await generateDeviceKeys();
  return { signer: cryptoKeySigner(k.signPub, k.sign.privateKey), kxPub: k.kxPub, kx: k.kx };
}

export function shuffle<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let x = seed;
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
