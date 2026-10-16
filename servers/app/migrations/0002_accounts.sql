-- アカウント文書（暗号化された鍵 bundle とロック解除手段）。アカウント鍵の署名付き。
-- ピア間では ts の新しい方を採用し、updated_at（このサーバーで更新した時刻）をカーソルに同期する。
CREATE TABLE accounts (
  pk TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  payload TEXT NOT NULL,
  sig TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX accounts_updated ON accounts (updated_at);
