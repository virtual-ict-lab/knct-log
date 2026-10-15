import { fromB64u, toB64u, utf8 } from "@knct-log/core";

const cache = new Map<string, Promise<CryptoKey>>();

function key(secret: string) {
  let k = cache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    cache.set(secret, k);
  }
  return k;
}

export async function hmac(secret: string, msg: string): Promise<string> {
  return toB64u(new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), utf8.encode(msg))));
}

export async function hmacVerify(secret: string, msg: string, mac: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify("HMAC", await key(secret), fromB64u(mac), utf8.encode(msg));
  } catch {
    return false;
  }
}

/** `base64url(JSON).mac` 形式の署名付きトークン */
export async function seal(secret: string, purpose: string, data: object): Promise<string> {
  const body = toB64u(utf8.encode(JSON.stringify(data)));
  return `${body}.${await hmac(secret, `${purpose}:${body}`)}`;
}

export async function unseal<T extends { exp: number }>(secret: string, purpose: string, token: string, now: number) {
  const [body, mac] = token.split(".");
  if (!body || !mac || !(await hmacVerify(secret, `${purpose}:${body}`, mac))) return null;
  try {
    const data = JSON.parse(utf8.decode(fromB64u(body))) as T;
    return typeof data.exp === "number" && data.exp > now ? data : null;
  } catch {
    return null;
  }
}
