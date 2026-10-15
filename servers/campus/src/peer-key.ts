import { cryptoKeySigner, fromB64u, toB64u, type Signer } from "@knct-log/core";

/** PKCS#8（base64url）の Ed25519 秘密鍵から、ピア認証用の署名者を作る */
export async function peerSigner(pkcs8B64u: string): Promise<Signer> {
  const priv = await crypto.subtle.importKey("pkcs8", fromB64u(pkcs8B64u), { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", priv);
  return cryptoKeySigner(jwk.x!, priv);
}

export async function generatePeerKey() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    privatePkcs8: toB64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey))),
    publicKey: toB64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))),
  };
}
