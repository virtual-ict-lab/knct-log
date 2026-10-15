-- 署名済みレコード。サーバーは payload を解釈して索引用の列だけを取り出す。
CREATE TABLE records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  grp TEXT NOT NULL,
  kind TEXT NOT NULL,
  author TEXT NOT NULL,
  ts INTEGER NOT NULL,
  exp INTEGER,
  payload TEXT NOT NULL,
  sig TEXT NOT NULL,
  -- 'direct': クライアントから直接受け取った / 'peer': ピアから同期で受け取った
  origin TEXT NOT NULL,
  -- ピアに送信済みか（ピアから受け取ったものは 1。ピアの DB が作り直されたら全件 0 に戻して送り直す）
  pushed INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL
);
CREATE INDEX records_grp_seq ON records (grp, seq);
CREATE INDEX records_grp_kind ON records (grp, kind);
CREATE INDEX records_exp ON records (exp) WHERE exp IS NOT NULL;
CREATE INDEX records_unpushed ON records (seq) WHERE pushed = 0;

-- 制御レコードから導出したキャッシュ。いつでも records から作り直せる。
CREATE TABLE groups (
  grp TEXT PRIMARY KEY,
  admin TEXT,
  dissolved INTEGER NOT NULL DEFAULT 0,
  hours_start INTEGER NOT NULL,
  hours_end INTEGER NOT NULL,
  utc_offset_min INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE members (
  grp TEXT NOT NULL,
  pk TEXT NOT NULL,
  PRIMARY KEY (grp, pk)
);
CREATE INDEX members_pk ON members (pk);

-- 暗号化済み動画。id は暗号文の sha256。
CREATE TABLE blobs (
  id TEXT PRIMARY KEY,
  grp TEXT NOT NULL,
  size INTEGER NOT NULL,
  exp INTEGER NOT NULL,
  stored INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX blobs_exp ON blobs (exp);
CREATE INDEX blobs_unstored ON blobs (created_at) WHERE stored = 0;

-- Web Push の購読。ピア間で updated_at の新しい方を採用して同期する。
CREATE TABLE push_subs (
  endpoint TEXT PRIMARY KEY,
  pk TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX push_subs_pk ON push_subs (pk);
CREATE INDEX push_subs_updated ON push_subs (updated_at);

-- 毎時プロンプトの送信済みスロット（UTC の 'YYYY-MM-DDTHH'）。ピア間で同期して二重送信を防ぐ。
CREATE TABLE push_slots (
  slot TEXT PRIMARY KEY,
  sent_by TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);

CREATE TABLE kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
