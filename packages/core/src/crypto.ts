import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { concat, fromB64u, randomBytes, toB64u, utf8 } from "./bytes.ts";

/** 端末の鍵ペア。秘密鍵は non-extractable の CryptoKey として IndexedDB に保存する。 */
export interface DeviceKeys {
  sign: CryptoKeyPair; // Ed25519
  kx: CryptoKeyPair; // X25519
  signPub: string; // base64url raw 32 bytes
  kxPub: string; // base64url raw 32 bytes
}

export async function generateDeviceKeys(): Promise<DeviceKeys> {
  const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const kx = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  return {
    sign,
    kx,
    signPub: toB64u(new Uint8Array((await crypto.subtle.exportKey("raw", sign.publicKey)) as ArrayBuffer)),
    kxPub: toB64u(new Uint8Array((await crypto.subtle.exportKey("raw", kx.publicKey)) as ArrayBuffer)),
  };
}

export async function sign(key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, data));
}

export async function verify(pub: string, data: Uint8Array<ArrayBuffer>, sig: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const raw = fromB64u(pub);
  if (raw.length !== 32 || sig.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, data);
  } catch {
    return false;
  }
}

export async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

const NONCE_LEN = 12;

/** AES-256-GCM。出力は nonce(12) || ciphertext+tag。 */
export async function aeadSeal(
  key: Uint8Array<ArrayBuffer>,
  plaintext: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const nonce = randomBytes(NONCE_LEN);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, k, plaintext);
  return concat(nonce, new Uint8Array(ct));
}

export async function aeadOpen(
  key: Uint8Array<ArrayBuffer>,
  sealed: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.subarray(0, NONCE_LEN), additionalData: aad },
    k,
    sealed.subarray(NONCE_LEN),
  );
  return new Uint8Array(pt);
}

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

function wrapInfo(groupId: string, epoch: string): Uint8Array<ArrayBuffer> {
  return utf8.encode(`knct-log/v1/key.wrap/${groupId}/${epoch}`);
}

/** グループ鍵を受信者の X25519 公開鍵に HPKE(base mode) で包む。 */
export async function wrapGroupKey(
  recipientKxPub: string,
  groupKey: Uint8Array<ArrayBuffer>,
  groupId: string,
  epoch: string,
): Promise<{ enc: string; ct: string }> {
  const recipientPublicKey = await suite.kem.deserializePublicKey(fromB64u(recipientKxPub).buffer);
  const { enc, ct } = await suite.seal({ recipientPublicKey, info: wrapInfo(groupId, epoch).buffer }, groupKey.buffer);
  return { enc: toB64u(new Uint8Array(enc)), ct: toB64u(new Uint8Array(ct)) };
}

export async function unwrapGroupKey(
  kx: CryptoKeyPair,
  wrapped: { enc: string; ct: string },
  groupId: string,
  epoch: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const pt = await suite.open(
    { recipientKey: kx, enc: fromB64u(wrapped.enc).buffer, info: wrapInfo(groupId, epoch).buffer },
    fromB64u(wrapped.ct).buffer,
  );
  return new Uint8Array(pt);
}
