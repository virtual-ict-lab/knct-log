import { fromB64u, toB64u, utf8 } from "./bytes.ts";
import { sha256, sign, verify } from "./crypto.ts";

export const PROTOCOL_VERSION = 1;
export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_DEPS = 32;
export const MAX_BLOBS = 4;
export const MAX_MEMBERS = 12;
export const POST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const CONTROL_KINDS = [
  "group.create",
  "group.settings",
  "invite",
  "invite.revoke",
  "member.join",
  "member.leave",
  "admin.transfer",
  "key.rotate",
] as const;
export const CONTENT_KINDS = ["key.wrap", "profile", "post"] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];
export type ContentKind = (typeof CONTENT_KINDS)[number];
export type Kind = ControlKind | ContentKind;

export function isControlKind(k: string): k is ControlKind {
  return (CONTROL_KINDS as readonly string[]).includes(k);
}

export interface Header {
  v: 1;
  group: string;
  kind: Kind;
  author: string;
  ts: number;
  deps: string[];
  exp?: number;
  epoch?: string;
  blobs?: string[];
  body?: Record<string, unknown>;
  ct?: string;
}

/** ワイヤ上の形式。payload は作成者が出力した JSON バイト列そのもの。 */
export interface Envelope {
  payload: string;
  sig: string;
}

export interface VerifiedRecord {
  id: string;
  header: Header;
  envelope: Envelope;
}

export class RecordError extends Error {}

const B64U_32 = /^[A-Za-z0-9_-]{43}$/; // 32 bytes
const B64U_16 = /^[A-Za-z0-9_-]{22}$/; // 16 bytes
const B64U = /^[A-Za-z0-9_-]+$/;

const isKey = (v: unknown): v is string => typeof v === "string" && B64U_32.test(v);
const isId = isKey; // sha256 → 32 bytes
const isB64u = (v: unknown, max = MAX_PAYLOAD_BYTES * 2): v is string =>
  typeof v === "string" && v.length <= max && B64U.test(v);

export function isGroupId(v: unknown): v is string {
  return typeof v === "string" && B64U_16.test(v);
}

type BodyCheck = (b: Record<string, unknown>) => boolean;
const opt = (v: unknown, f: (v: unknown) => boolean) => v === undefined || f(v);
const isHour = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 24;

const BODY: Record<Kind, { body: BodyCheck; ct: boolean; epoch: boolean }> = {
  "group.create": { body: (b) => isKey(b.kx), ct: false, epoch: false },
  "group.settings": {
    body: (b) =>
      opt(b.hours, (h) => Array.isArray(h) && h.length === 2 && h.every(isHour) && h[0] < h[1]) &&
      opt(b.utcOffsetMin, (o) => Number.isInteger(o) && Math.abs(o as number) <= 14 * 60),
    ct: true,
    epoch: true,
  },
  invite: { body: (b) => isKey(b.th) && opt(b.exp, Number.isSafeInteger), ct: false, epoch: false },
  "invite.revoke": { body: (b) => isId(b.invite), ct: false, epoch: false },
  "member.join": { body: (b) => isKey(b.kx) && isId(b.invite) && isKey(b.token), ct: false, epoch: false },
  "member.leave": { body: (b) => opt(b.successor, isKey), ct: false, epoch: false },
  "admin.transfer": { body: (b) => isKey(b.to), ct: false, epoch: false },
  "key.rotate": { body: (b) => isId(b.parent), ct: false, epoch: false },
  "key.wrap": { body: (b) => isKey(b.to) && isB64u(b.enc, 64) && isB64u(b.ct, 128), ct: false, epoch: true },
  profile: { body: () => true, ct: true, epoch: true },
  post: { body: () => true, ct: true, epoch: true },
};

export function validateHeader(h: unknown): asserts h is Header {
  const fail = (m: string): never => {
    throw new RecordError(m);
  };
  if (typeof h !== "object" || h === null || Array.isArray(h)) fail("header must be an object");
  const r = h as Record<string, unknown>;
  if (r.v !== PROTOCOL_VERSION) fail("unsupported version");
  if (!isGroupId(r.group)) fail("invalid group");
  if (typeof r.kind !== "string" || !(r.kind in BODY)) fail("invalid kind");
  if (!isKey(r.author)) fail("invalid author");
  if (!Number.isSafeInteger(r.ts) || (r.ts as number) < 0) fail("invalid ts");
  if (!Array.isArray(r.deps) || r.deps.length > MAX_DEPS || !r.deps.every(isId)) fail("invalid deps");
  if (new Set(r.deps as string[]).size !== (r.deps as string[]).length) fail("duplicate deps");
  if (!opt(r.exp, Number.isSafeInteger)) fail("invalid exp");
  if (!opt(r.blobs, (b) => Array.isArray(b) && b.length <= MAX_BLOBS && b.every(isId))) fail("invalid blobs");
  if (!opt(r.body, (b) => typeof b === "object" && b !== null && !Array.isArray(b))) fail("invalid body");
  const spec = BODY[r.kind as Kind];
  if (spec.epoch !== isId(r.epoch)) fail(spec.epoch ? "epoch required" : "epoch not allowed");
  if (spec.ct !== isB64u(r.ct)) fail(spec.ct ? "ct required" : "ct not allowed");
  if (!spec.body((r.body ?? {}) as Record<string, unknown>)) fail(`invalid body for ${r.kind as string}`);
  if (r.kind === "post" && (!Array.isArray(r.blobs) || r.blobs.length === 0 || r.exp === undefined))
    fail("post requires blobs and exp");
}

export async function recordId(payload: Uint8Array<ArrayBuffer>): Promise<string> {
  return toB64u(await sha256(payload));
}

export interface Signer {
  pub: string;
  sign(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
}

export function cryptoKeySigner(pub: string, key: CryptoKey): Signer {
  return { pub, sign: (d) => sign(key, d) };
}

export async function createRecord(
  signer: Signer,
  fields: Omit<Header, "v" | "author" | "ts"> & { ts?: number },
): Promise<VerifiedRecord> {
  const header = { ...fields, v: PROTOCOL_VERSION, author: signer.pub, ts: fields.ts ?? Date.now() } as Header;
  validateHeader(header);
  const payload = utf8.encode(JSON.stringify(header));
  if (payload.length > MAX_PAYLOAD_BYTES) throw new RecordError("payload too large");
  const envelope = { payload: toB64u(payload), sig: toB64u(await signer.sign(payload)) };
  return { id: await recordId(payload), header, envelope };
}

/** 受信した envelope を検証する。署名・形式・サイズのすべてを確認する。 */
export async function openRecord(envelope: unknown): Promise<VerifiedRecord> {
  if (typeof envelope !== "object" || envelope === null) throw new RecordError("invalid envelope");
  const { payload, sig } = envelope as Record<string, unknown>;
  if (!isB64u(payload) || typeof sig !== "string") throw new RecordError("invalid envelope");
  const bytes = fromB64u(payload);
  if (bytes.length > MAX_PAYLOAD_BYTES) throw new RecordError("payload too large");
  let header: unknown;
  try {
    header = JSON.parse(utf8.decode(bytes));
  } catch {
    throw new RecordError("payload is not JSON");
  }
  validateHeader(header);
  if (!(await verify(header.author, bytes, fromB64u(sig)))) throw new RecordError("bad signature");
  return { id: await recordId(bytes), header, envelope: { payload, sig } };
}

/** 暗号文の AAD。グループ・種類・epoch・作成者に束縛する。 */
export function contentAad(h: Pick<Header, "group" | "kind" | "epoch" | "author">): Uint8Array<ArrayBuffer> {
  return utf8.encode(`knct-log/v1/${h.group}/${h.kind}/${h.epoch ?? ""}/${h.author}`);
}
