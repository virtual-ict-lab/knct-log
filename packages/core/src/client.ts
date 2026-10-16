import { toB64u, utf8 } from "./bytes.ts";
import type { Envelope, Signer } from "./record.ts";

export const AUTH_CONTEXT = "knct-log/v1/auth:";

export type IngestResult =
  | { id: string; status: "ok" | "dup" }
  | { id: string | null; status: "invalid"; reason: string }
  | { id: string; status: "missing"; missing: string[] };

export interface RecordPage {
  records: Envelope[];
  next: number;
  more: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** knct-log サーバー 1 台に対するクライアント。端末鍵（またはピア鍵）でトークンを取得する。 */
export class ApiClient {
  readonly baseUrl: string;
  private readonly signer: Signer;
  private readonly fetchFn: typeof fetch;
  private token: { value: string; exp: number } | null = null;

  constructor(baseUrl: string, signer: Signer, fetchFn: typeof fetch = (...a) => fetch(...a)) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.signer = signer;
    this.fetchFn = fetchFn;
  }

  async health(timeoutMs?: number): Promise<{ server_id: string; instance?: string; time: number }> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/health`, {
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!res.ok) throw new ApiError(res.status, "health check failed");
    return res.json();
  }

  private async authToken(): Promise<string> {
    if (this.token && this.token.exp - 60_000 > Date.now()) return this.token.value;
    const { challenge } = await this.raw<{ challenge: string }>("POST", "/v1/auth/challenge", {}, false);
    const sig = await this.signer.sign(utf8.encode(AUTH_CONTEXT + challenge));
    const res = await this.raw<{ token: string; exp: number }>(
      "POST",
      "/v1/auth/token",
      { pk: this.signer.pub, challenge, sig: toB64u(sig) },
      false,
    );
    this.token = { value: res.token, exp: res.exp };
    return res.token;
  }

  private async raw<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) headers.Authorization = `Bearer ${await this.authToken()}`;
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && auth && this.token) {
      this.token = null;
      return this.raw(method, path, body, auth);
    }
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new ApiError(res.status, `${method} ${path}: ${res.status} ${msg}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  myGroups() {
    return this.raw<{ groups: { group: string; admin: string | null; dissolved: boolean }[] }>("GET", "/v1/me/groups");
  }

  postRecords(group: string, records: Envelope[]) {
    return this.raw<{ results: IngestResult[] }>("POST", `/v1/groups/${group}/records`, { records });
  }

  getRecords(group: string, after = 0, limit = 200) {
    return this.raw<RecordPage>("GET", `/v1/groups/${group}/records?after=${after}&limit=${limit}`);
  }

  async uploadBlob(group: string, id: string, data: Uint8Array<ArrayBuffer>) {
    const r = await this.raw<{ stored: boolean; url?: string; headers?: Record<string, string> }>(
      "POST",
      "/v1/blobs/upload-url",
      { group, id, size: data.length },
    );
    if (r.stored) return;
    const res = await this.fetchFn(r.url!, { method: "PUT", headers: r.headers, body: data });
    if (!res.ok) throw new ApiError(res.status, `blob upload failed: ${res.status}`);
  }

  async downloadBlob(id: string): Promise<Uint8Array<ArrayBuffer>> {
    const { url } = await this.raw<{ url: string }>("POST", "/v1/blobs/download-url", { id });
    const res = await this.fetchFn(url);
    if (!res.ok) throw new ApiError(res.status, `blob download failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** アカウント文書（暗号化された鍵と、ロック解除手段）。認証なしで取得できる */
  async getAccount(pk: string): Promise<Envelope | null> {
    try {
      return await this.raw<Envelope>("GET", `/v1/accounts/${pk}`, undefined, false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  /** アカウント文書を更新する。ts が保存済みより古いと 409 */
  putAccount(env: Envelope) {
    return this.raw<void>("PUT", "/v1/accounts", env, false);
  }

  pushSubscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
    return this.raw<void>("POST", "/v1/push/subscribe", sub);
  }

  pushUnsubscribe(endpoint: string) {
    return this.raw<void>("POST", "/v1/push/unsubscribe", { endpoint });
  }

  // ---- ピア用 ----
  peerRecords(after = 0, limit = 200) {
    return this.raw<RecordPage>("GET", `/v1/peer/records?after=${after}&limit=${limit}`);
  }

  peerPostRecords(records: Envelope[]) {
    return this.raw<{ results: IngestResult[] }>("POST", "/v1/peer/records", { records });
  }

  peerGet<T>(path: string) {
    return this.raw<T>("GET", `/v1/peer/${path}`);
  }

  peerPost(path: string, body: unknown) {
    return this.raw<void>("POST", `/v1/peer/${path}`, body);
  }
}
