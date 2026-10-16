import { PRF_SALT, fromB64u, randomBytes, toB64u } from "@knct-log/core";

/**
 * パスキー（WebAuthn）。サーバーでの検証はせず、PRF 拡張の出力だけを使う。
 * 出力はパスキーごとに決まった 32 バイトで、アカウントの鍵を開く KEK の元になる。
 * パスキーが Google パスワードマネージャーや iCloud キーチェーンで同期されていれば、
 * 新しい端末でも同じ出力が得られる。
 */
export interface Passkey {
  register(account: string, name: string): Promise<{ credId: string; prf: Uint8Array<ArrayBuffer> }>;
  authenticate(): Promise<{ credId: string; account: string; prf: Uint8Array<ArrayBuffer> }>;
}

export class PasskeyError extends Error {
  readonly code: "unsupported" | "no-prf" | "cancelled";
  constructor(code: PasskeyError["code"], message: string = code) {
    super(message);
    this.code = code;
  }
}

/** CF Pages と学内サーバーで同じパスキーを使えるよう、共通の親ドメインを RP ID にできる */
function rpId() {
  return import.meta.env.VITE_RP_ID || location.hostname;
}

type PrfOutput = { enabled?: boolean; results?: { first?: BufferSource } };

function prfOf(cred: PublicKeyCredential): PrfOutput | undefined {
  return (cred.getClientExtensionResults() as { prf?: PrfOutput }).prf;
}

/**
 * PRF の結果をコピーして取り出す。Firefox では別の realm の ArrayBuffer が返り
 * `instanceof ArrayBuffer` が偽になるので、ビューかどうかで判定する。
 */
function bytes(b: BufferSource): Uint8Array<ArrayBuffer> {
  const view = ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b as ArrayBuffer);
  return new Uint8Array(view);
}

function wrapError(e: unknown): never {
  if (e instanceof PasskeyError) throw e;
  if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError")) throw new PasskeyError("cancelled", e.message);
  throw e;
}

export function passkeySupported() {
  return typeof PublicKeyCredential !== "undefined" && !!navigator.credentials;
}

async function getPrf(allow?: ArrayBuffer) {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      rpId: rpId(),
      userVerification: "required",
      allowCredentials: allow ? [{ type: "public-key", id: allow }] : undefined,
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new PasskeyError("cancelled");
  const first = prfOf(cred)?.results?.first;
  if (!first) throw new PasskeyError("no-prf");
  return { cred, prf: bytes(first) };
}

export const webPasskey: Passkey = {
  async register(account, name) {
    if (!passkeySupported()) throw new PasskeyError("unsupported");
    try {
      const cred = (await navigator.credentials.create({
        publicKey: {
          rp: { id: rpId(), name: "knct-log" },
          // user.id = アカウントの公開鍵。ログイン時に userHandle として返り、どのアカウントかが分かる
          user: { id: fromB64u(account), name, displayName: name },
          challenge: randomBytes(32),
          pubKeyCredParams: [
            { type: "public-key", alg: -8 },
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
          extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      if (!cred) throw new PasskeyError("cancelled");
      const credId = toB64u(new Uint8Array(cred.rawId));
      const ext = prfOf(cred);
      if (ext?.results?.first) return { credId, prf: bytes(ext.results.first) };
      if (ext?.enabled === false || !ext) throw new PasskeyError("no-prf");
      // 作成時に値を返さない認証器では、続けて一度認証して取得する
      const { prf } = await getPrf(cred.rawId);
      return { credId, prf };
    } catch (e) {
      wrapError(e);
    }
  },

  async authenticate() {
    if (!passkeySupported()) throw new PasskeyError("unsupported");
    try {
      const { cred, prf } = await getPrf();
      const handle = (cred.response as AuthenticatorAssertionResponse).userHandle;
      if (!handle) throw new PasskeyError("no-prf", "no user handle");
      return { credId: toB64u(new Uint8Array(cred.rawId)), account: toB64u(new Uint8Array(handle)), prf };
    } catch (e) {
      wrapError(e);
    }
  },
};
