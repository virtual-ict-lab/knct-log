/** ランタイム（Workers / Node）ごとに差し替える依存。 */

export interface Sql {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  /** 複数の文を1トランザクションで実行する */
  batch(stmts: { sql: string; params: unknown[] }[]): Promise<void>;
}

/** 暗号化済み blob の実体を置く場所（R2 / ローカル fs / S3 互換）。 */
export interface BlobStore {
  put(id: string, data: Uint8Array<ArrayBuffer>): Promise<void>;
  get(id: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(ids: string[]): Promise<void>;
  /**
   * 実体があればサイズを返す。presigned URL でストレージに直接アップロードされる構成では、
   * app が PUT を見ないので、これで到着を確認する。
   */
  head?(id: string): Promise<number | null>;
}

/**
 * blob の upload/download URL を発行する。省略時は app 自身の
 * `/v1/blobs/raw/:id` を HMAC 署名付きで返す（R2 の S3 presigned に差し替え可能）。
 */
export interface BlobUrls {
  upload(id: string, size: number): Promise<{ url: string; headers: Record<string, string> }>;
  download(id: string): Promise<string>;
}

export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface Pusher {
  /** 送信に失敗して購読が無効（404/410）になった endpoint を返す */
  send(subs: PushSubscription[], payload: unknown): Promise<{ gone: string[] }>;
}

export interface Deps {
  sql: Sql;
  blobs: BlobStore;
  blobUrls?: BlobUrls;
  pusher?: Pusher;
  /** 例: "cf" / "campus" */
  serverId: string;
  /** トークンと blob URL の HMAC 鍵（ピアごとに別でよい） */
  secret: string;
  /** 他ピアの Ed25519 公開鍵。これらの鍵で認証した相手はピア権限を持つ */
  peerKeys: string[];
  /** この サーバーの外部 URL（blob URL の組み立てに使う）。省略時はリクエストの origin */
  publicUrl?: string;
  /** バックグラウンド処理を登録する（Workers の waitUntil など） */
  defer?: (p: Promise<unknown>) => void;
  now?: () => number;
}
