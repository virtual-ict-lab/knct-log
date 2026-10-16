import { fromB64u, randomBytes, toB64u, utf8 } from "./bytes.ts";
import { aeadOpen, aeadSeal, type DeviceKeys, verify } from "./crypto.ts";
import type { Envelope, Signer } from "./record.ts";

/**
 * アカウント = 端末間で共有する署名鍵と鍵共有鍵。グループのメンバーはアカウントの公開鍵で表す。
 *
 * 秘密鍵は bundle として AMK（アカウントごとの乱数 32B）で暗号化し、サーバーに置く。
 * AMK はロック解除手段（unlock）ごとに別々の KEK で包む:
 * - passkey: WebAuthn の PRF 拡張の出力から導出（同期されたパスキーがあれば新しい端末でも解ける）
 * - link: 既存の端末が QR で渡す一時的な乱数から導出（期限付き）
 * サーバーには暗号文しかないので、取得に認証は要らない。書き込みはアカウント鍵の署名で守る。
 */

export interface AccountSecret {
  v: 1;
  /** Ed25519 秘密鍵（PKCS#8 DER） */
  signPkcs8: string;
  /** X25519 秘密鍵（PKCS#8 DER） */
  kxPkcs8: string;
  signPub: string;
  kxPub: string;
  name: string;
}

export type UnlockKind = "passkey" | "link";

export interface Unlock {
  /** passkey は credential ID、link は乱数 */
  id: string;
  kind: UnlockKind;
  exp?: number;
  /** AES-256-GCM(KEK, AMK) */
  box: string;
}

export interface AccountDoc {
  v: 1;
  account: string;
  ts: number;
  bundle: string;
  unlocks: Unlock[];
}

export const MAX_UNLOCKS = 16;
export const LINK_TTL_MS = 10 * 60 * 1000;
/** WebAuthn PRF に渡す salt（全アカウント共通。認証器が credential ごとに別の値を返す） */
export const PRF_SALT = utf8.encode("knct-log/v1/prf");

const B64U = /^[A-Za-z0-9_-]+$/;
const isKey = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
const b64u = (v: unknown, max: number) => typeof v === "string" && v.length <= max && B64U.test(v);

async function exportRaw(key: CryptoKey) {
  return toB64u(new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer));
}
async function exportPkcs8(key: CryptoKey) {
  return toB64u(new Uint8Array((await crypto.subtle.exportKey("pkcs8", key)) as ArrayBuffer));
}

/** 新しいアカウントの鍵を作る。秘密鍵は bundle に入れるため一度だけ取り出す。 */
export async function generateAccountSecret(name: string): Promise<AccountSecret> {
  const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const kx = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    v: 1,
    signPkcs8: await exportPkcs8(sign.privateKey),
    kxPkcs8: await exportPkcs8(kx.privateKey),
    signPub: await exportRaw(sign.publicKey),
    kxPub: await exportRaw(kx.publicKey),
    name,
  };
}

/** bundle の秘密鍵を、この端末で使う non-extractable な CryptoKey にする（公開鍵は HPKE が取り出すので extractable） */
export async function importAccountKeys(s: AccountSecret): Promise<DeviceKeys> {
  const imp = (fmt: "pkcs8" | "raw", data: string, alg: string, usages: ("sign" | "verify" | "deriveBits")[]) =>
    crypto.subtle.importKey(fmt, fromB64u(data), { name: alg }, fmt === "raw", usages);
  return {
    sign: { privateKey: await imp("pkcs8", s.signPkcs8, "Ed25519", ["sign"]), publicKey: await imp("raw", s.signPub, "Ed25519", ["verify"]) },
    kx: { privateKey: await imp("pkcs8", s.kxPkcs8, "X25519", ["deriveBits"]), publicKey: await imp("raw", s.kxPub, "X25519", []) },
    signPub: s.signPub,
    kxPub: s.kxPub,
  };
}

export function newAmk() {
  return randomBytes(32);
}

/** ロック解除手段の秘密（PRF の出力やリンクの乱数）から KEK を導出する */
export async function deriveKek(ikm: Uint8Array<ArrayBuffer>, kind: UnlockKind): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8.encode(`knct-log/v1/unlock/${kind}`) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

const bundleAad = (account: string) => utf8.encode(`knct-log/v1/account/${account}/bundle`);
const unlockAad = (account: string, id: string) => utf8.encode(`knct-log/v1/account/${account}/unlock/${id}`);

export async function sealBundle(amk: Uint8Array<ArrayBuffer>, s: AccountSecret) {
  return toB64u(await aeadSeal(amk, utf8.encode(JSON.stringify(s)), bundleAad(s.signPub)));
}

export async function openBundle(amk: Uint8Array<ArrayBuffer>, doc: AccountDoc): Promise<AccountSecret> {
  const s = JSON.parse(utf8.decode(await aeadOpen(amk, fromB64u(doc.bundle), bundleAad(doc.account)))) as AccountSecret;
  if (s.signPub !== doc.account) throw new Error("bundle does not belong to this account");
  return s;
}

export async function makeUnlock(
  amk: Uint8Array<ArrayBuffer>,
  account: string,
  kind: UnlockKind,
  id: string,
  kek: Uint8Array<ArrayBuffer>,
  exp?: number,
): Promise<Unlock> {
  const box = toB64u(await aeadSeal(kek, amk, unlockAad(account, id)));
  return exp === undefined ? { id, kind, box } : { id, kind, exp, box };
}

export async function openUnlock(doc: AccountDoc, u: Unlock, kek: Uint8Array<ArrayBuffer>) {
  return aeadOpen(kek, fromB64u(u.box), unlockAad(doc.account, u.id));
}

export function validateAccountDoc(d: unknown): asserts d is AccountDoc {
  const fail = (m: string): never => {
    throw new Error(`invalid account doc: ${m}`);
  };
  if (typeof d !== "object" || d === null) fail("not an object");
  const r = d as Record<string, unknown>;
  if (r.v !== 1) fail("version");
  if (!isKey(r.account)) fail("account");
  if (!Number.isSafeInteger(r.ts)) fail("ts");
  if (!b64u(r.bundle, 8192)) fail("bundle");
  if (!Array.isArray(r.unlocks) || r.unlocks.length > MAX_UNLOCKS) fail("unlocks");
  for (const u of r.unlocks as Record<string, unknown>[]) {
    if (typeof u !== "object" || u === null) fail("unlock");
    if (!b64u(u.id, 512) || (u.kind !== "passkey" && u.kind !== "link") || !b64u(u.box, 128)) fail("unlock");
    if (u.exp !== undefined && !Number.isSafeInteger(u.exp)) fail("unlock exp");
  }
}

/** アカウント鍵で署名した文書。形式はグループのレコードと同じ { payload, sig } */
export async function signAccountDoc(signer: Signer, doc: AccountDoc): Promise<Envelope> {
  validateAccountDoc(doc);
  if (doc.account !== signer.pub) throw new Error("signer must be the account");
  const payload = utf8.encode(JSON.stringify(doc));
  return { payload: toB64u(payload), sig: toB64u(await signer.sign(payload)) };
}

export async function openAccountDoc(env: unknown): Promise<AccountDoc> {
  if (typeof env !== "object" || env === null) throw new Error("invalid envelope");
  const { payload, sig } = env as Record<string, unknown>;
  if (!b64u(payload, 32 * 1024) || !b64u(sig, 128)) throw new Error("invalid envelope");
  const bytes = fromB64u(payload as string);
  const doc = JSON.parse(utf8.decode(bytes)) as unknown;
  validateAccountDoc(doc);
  if (!(await verify(doc.account, bytes, fromB64u(sig as string)))) throw new Error("bad signature");
  return doc;
}

/** 期限切れのリンクを除いた unlock 一覧に、指定の unlock を追加（同じ id は置き換え）する */
export function withUnlock(doc: AccountDoc, u: Unlock | null, removeId?: string, now = Date.now()): Unlock[] {
  const keep = doc.unlocks.filter((x) => (x.exp === undefined || x.exp > now) && x.id !== removeId && x.id !== u?.id);
  if (u) keep.push(u);
  if (keep.length > MAX_UNLOCKS) throw new Error("ロック解除の方法が多すぎます");
  return keep;
}
