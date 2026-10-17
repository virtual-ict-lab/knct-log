import { fromB64u, randomBytes, toB64u, utf8 } from "./bytes.ts";
import { aeadOpen, aeadSeal, sha256, wrapGroupKey } from "./crypto.ts";
import type { GroupState } from "./membership.ts";
import { type Header, POST_TTL_MS, type Signer, type VerifiedRecord, contentAad, createRecord } from "./record.ts";

/** グループ操作に必要な端末側の情報 */
export interface Actor {
  signer: Signer;
  kxPub: string;
}

/** アイコン画像は data URL（"data:image/webp;base64,..."）。レコードの上限に収めるため小さく保つ */
export const MAX_ICON_CHARS = 9000;
const ICON_RE = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/;

/** 表示してよいアイコンか（形式と大きさだけを見る） */
export function isIcon(v: unknown): v is string {
  return typeof v === "string" && v.length <= MAX_ICON_CHARS && ICON_RE.test(v);
}

export interface GroupMeta {
  name: string;
  icon?: string;
}

export interface Profile {
  name: string;
  icon?: string;
}

export interface PostContent {
  /** 動画の content key（base64url） */
  ck: string;
  mime: string;
  durationMs: number;
  takenAt: number;
  /** 動画の中央に重ねて表示する文字（任意） */
  text?: string;
  /** 表示したときの幅と高さ（任意）。縦長・横長の判定と並べ方に使う */
  w?: number;
  h?: number;
}

export const MAX_POST_TEXT = 40;
export const MAX_REPLY_TEXT = 200;

export interface ReactionContent {
  /** 対象の投稿 ID */
  ref: string;
  /** 絵文字。空文字はリアクションの取り消し */
  emoji: string;
}

export interface ReplyContent {
  ref: string;
  text: string;
}

/** 投稿の文字の変更。空文字は文字を消す */
export interface PostEditContent {
  ref: string;
  text: string;
}

/** 反応先の投稿 */
export interface PostRef {
  id: string;
  author: string;
  exp: number;
}

async function sealJson(key: Uint8Array<ArrayBuffer>, h: Pick<Header, "group" | "kind" | "epoch" | "author">, obj: unknown) {
  return toB64u(await aeadSeal(key, utf8.encode(JSON.stringify(obj)), contentAad(h)));
}

export async function openContent<T>(key: Uint8Array<ArrayBuffer>, h: Header): Promise<T> {
  if (!h.ct) throw new Error("record has no ct");
  return JSON.parse(utf8.decode(await aeadOpen(key, fromB64u(h.ct), contentAad(h)))) as T;
}

export function newGroupId(): string {
  return toB64u(randomBytes(16));
}

/** グループを作る。group.create・自分宛の key.wrap・group.settings を返す。 */
export async function createGroup(actor: Actor, meta: GroupMeta, group = newGroupId()) {
  const create = await createRecord(actor.signer, { group, kind: "group.create", deps: [], body: { kx: actor.kxPub } });
  const epoch = create.id;
  const key = randomBytes(32);
  const wrap = await wrapFor(actor, group, epoch, key, { pk: actor.signer.pub, kx: actor.kxPub, since: create.id });
  const settings = await sealedRecord(actor, group, "group.settings", epoch, key, meta, { deps: [create.id] });
  return { group, epoch, key, records: [create, wrap, settings] };
}

export async function updateSettings(
  actor: Actor,
  s: GroupState,
  key: Uint8Array<ArrayBuffer>,
  meta: GroupMeta,
  pub: { hours?: [number, number]; utcOffsetMin?: number; editableBy?: "admin" | "members" } = {},
) {
  if (meta.icon !== undefined && !isIcon(meta.icon)) throw new Error("invalid icon");
  return sealedRecord(actor, s.group, "group.settings", s.currentEpoch!, key, meta, { deps: s.heads, body: pub });
}

/** 招待を作る。token はリンクのフラグメントで渡し、サーバーには sha256(token) だけを置く。 */
export async function createInvite(actor: Actor, s: GroupState, ttlMs = 7 * 24 * 60 * 60 * 1000) {
  const token = randomBytes(32);
  const record = await createRecord(actor.signer, {
    group: s.group,
    kind: "invite",
    deps: s.heads,
    body: { th: toB64u(await sha256(token)), exp: Date.now() + ttlMs },
  });
  return { record, token: toB64u(token) };
}

export async function revokeInvite(actor: Actor, s: GroupState, invite: string) {
  return createRecord(actor.signer, { group: s.group, kind: "invite.revoke", deps: s.heads, body: { invite } });
}

export async function joinGroup(actor: Actor, group: string, invite: string, token: string) {
  return createRecord(actor.signer, {
    group,
    kind: "member.join",
    deps: [invite],
    body: { kx: actor.kxPub, invite, token },
  });
}

export async function leaveGroup(actor: Actor, s: GroupState, successor?: string) {
  return createRecord(actor.signer, {
    group: s.group,
    kind: "member.leave",
    deps: s.heads,
    body: successor ? { successor } : {},
  });
}

export async function transferAdmin(actor: Actor, s: GroupState, to: string) {
  return createRecord(actor.signer, { group: s.group, kind: "admin.transfer", deps: s.heads, body: { to } });
}

/** 新しい epoch を作り、現メンバー全員に鍵を wrap する。 */
export async function rotateKey(actor: Actor, s: GroupState) {
  const parent = s.currentEpoch!;
  const deps = s.heads.includes(parent) ? s.heads : [...s.heads, parent];
  const rotate = await createRecord(actor.signer, { group: s.group, kind: "key.rotate", deps, body: { parent } });
  const key = randomBytes(32);
  const wraps = await Promise.all([...s.members.values()].map((m) => wrapFor(actor, s.group, rotate.id, key, m)));
  return { epoch: rotate.id, key, records: [rotate, ...wraps] };
}

export async function wrapFor(
  actor: Actor,
  group: string,
  epoch: string,
  key: Uint8Array<ArrayBuffer>,
  member: { pk: string; kx: string; since: string },
) {
  const { enc, ct } = await wrapGroupKey(member.kx, key, group, epoch);
  const deps = epoch === member.since ? [epoch] : [epoch, member.since];
  return createRecord(actor.signer, { group, kind: "key.wrap", epoch, deps, body: { to: member.pk, enc, ct } });
}

export async function sealedRecord(
  actor: Actor,
  group: string,
  kind: "group.settings" | "profile" | "post" | "reaction" | "reply" | "post.edit",
  epoch: string,
  key: Uint8Array<ArrayBuffer>,
  content: unknown,
  extra: Partial<Pick<Header, "deps" | "blobs" | "exp" | "body" | "ts">> = {},
): Promise<VerifiedRecord> {
  const ts = extra.ts ?? Date.now();
  const ct = await sealJson(key, { group, kind, epoch, author: actor.signer.pub }, content);
  return createRecord(actor.signer, { deps: [epoch], ...extra, ts, group, kind, epoch, ct });
}

export async function setProfile(actor: Actor, s: GroupState, key: Uint8Array<ArrayBuffer>, profile: Profile) {
  if (profile.icon !== undefined && !isIcon(profile.icon)) throw new Error("invalid icon");
  return sealedRecord(actor, s.group, "profile", s.currentEpoch!, key, profile);
}

const BLOB_AAD = utf8.encode("knct-log/v1/blob");

/** 動画をクリップごとの content key で暗号化する。blob ID は暗号文の sha256。 */
export async function encryptBlob(plain: Uint8Array<ArrayBuffer>) {
  const ck = randomBytes(32);
  const sealed = await aeadSeal(ck, plain, BLOB_AAD);
  return { ck: toB64u(ck), sealed, blobId: toB64u(await sha256(sealed)) };
}

export async function decryptBlob(ck: string, sealed: Uint8Array<ArrayBuffer>, blobId?: string) {
  if (blobId !== undefined && toB64u(await sha256(sealed)) !== blobId) throw new Error("blob hash mismatch");
  return aeadOpen(fromB64u(ck), sealed, BLOB_AAD);
}

export async function createPost(
  actor: Actor,
  s: GroupState,
  key: Uint8Array<ArrayBuffer>,
  blobId: string,
  content: PostContent,
) {
  if (content.text !== undefined && content.text.length > MAX_POST_TEXT) throw new Error("text too long");
  const ts = Date.now();
  return sealedRecord(actor, s.group, "post", s.currentEpoch!, key, content, {
    ts,
    blobs: [blobId],
    exp: ts + POST_TTL_MS,
  });
}

/** 投稿へのリアクション。投稿と同じ時刻に消える。作成者ごと・投稿ごとに最新のものが有効 */
/** 作成者ごと・投稿ごとに ts が最新のものが有効。続けて押すときは ts を前より大きくする */
export async function createReaction(actor: Actor, s: GroupState, key: Uint8Array<ArrayBuffer>, post: PostRef, emoji: string, ts?: number) {
  const content: ReactionContent = { ref: post.id, emoji };
  return sealedRecord(actor, s.group, "reaction", s.currentEpoch!, key, content, { exp: post.exp, body: { to: post.author }, ts });
}

export async function createReply(actor: Actor, s: GroupState, key: Uint8Array<ArrayBuffer>, post: PostRef, text: string) {
  if (text.length > MAX_REPLY_TEXT) throw new Error("reply too long");
  const content: ReplyContent = { ref: post.id, text };
  return sealedRecord(actor, s.group, "reply", s.currentEpoch!, key, content, { exp: post.exp, body: { to: post.author } });
}

/** 自分の投稿の文字を変える。投稿者ごと・投稿ごとに ts が最新のものが有効 */
export async function editPost(actor: Actor, s: GroupState, key: Uint8Array<ArrayBuffer>, post: PostRef, text: string) {
  if (post.author !== actor.signer.pub) throw new Error("not my post");
  if (text.length > MAX_POST_TEXT) throw new Error("text too long");
  const content: PostEditContent = { ref: post.id, text };
  return sealedRecord(actor, s.group, "post.edit", s.currentEpoch!, key, content, { exp: post.exp });
}

/** 自分の投稿を消す。サーバーは動画を消し、端末は投稿を表示しない */
export async function deletePost(actor: Actor, s: GroupState, post: PostRef) {
  if (post.author !== actor.signer.pub) throw new Error("not my post");
  return createRecord(actor.signer, { group: s.group, kind: "post.delete", deps: [post.id], exp: post.exp, body: { post: post.id } });
}
