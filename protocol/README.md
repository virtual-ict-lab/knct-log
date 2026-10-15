# knct-log プロトコル v1

サーバー実装（Hono on Workers / Hono on Node）とクライアント実装（PWA、今後の Kotlin 版）が共有する仕様。
TypeScript の参照実装は `packages/core`、API の適合テストは `packages/conformance` にある。

## 基本方針

- **E2E 暗号化は端末で行う。** サーバーは「署名の検証・暗号文の保管と配布・Push」だけを担当し、動画・名前・撮影時刻は読めない。
- **データはすべて、クライアントが署名した不変レコード。** ID は内容ハッシュなので、複数サーバーが別々に受け付けても和集合で合流できる。
- **サーバーは対等なピア。** 学内サーバーと Cloudflare のどちらも正本ではなく、単独で書き込みを受け付ける。同期は学内側からの外向き通信だけで行う。

## エンコーディング

- バイナリはすべて **base64url（パディングなし）**。
- 公開鍵・ID・ハッシュは 32 バイト（43 文字）。グループ ID は 16 バイト乱数（22 文字）。
- 時刻は UNIX ミリ秒。

## 暗号

| 用途 | 方式 |
|---|---|
| 端末の署名鍵 | Ed25519（raw 公開鍵 32B） |
| 端末の鍵共有鍵 | X25519（raw 公開鍵 32B） |
| グループ鍵の配布 | HPKE RFC 9180 base mode, `DHKEM(X25519, HKDF-SHA256)` / `HKDF-SHA256` / `AES-256-GCM`, info = `knct-log/v1/key.wrap/<group>/<epoch>` |
| レコードの暗号文 `ct` | AES-256-GCM（鍵 = epoch のグループ鍵 32B）。出力 = `nonce(12) ‖ ciphertext ‖ tag`。AAD = `knct-log/v1/<group>/<kind>/<epoch>/<author>` |
| 動画 blob | AES-256-GCM（鍵 = クリップごとの乱数 `ck` 32B）、AAD = `knct-log/v1/blob`。blob ID = `sha256(暗号文)` |
| 認証 | Ed25519 で `knct-log/v1/auth:<challenge>` に署名 |

秘密鍵は端末から出さない（WebCrypto の non-extractable / Android Keystore）。1 端末 = 1 メンバー。

## レコード

```json
{ "payload": "<base64url(UTF-8 JSON バイト列)>", "sig": "<base64url(Ed25519(payload バイト列))>" }
```

- `id = base64url(sha256(payload のバイト列))`。JSON の正規化は不要（作成者が出したバイト列をそのまま扱う）。
- payload は 16KiB まで。

payload（ヘッダー）のフィールド:

| フィールド | 内容 |
|---|---|
| `v` | `1` |
| `group` | グループ ID |
| `kind` | 下表 |
| `author` | 作成者の Ed25519 公開鍵 |
| `ts` | 作成時刻 |
| `deps` | 因果的に先行するレコード ID（最大 32） |
| `epoch` | 暗号文に使ったグループ鍵の epoch（= `group.create` または `key.rotate` の ID） |
| `ct` | 暗号文（kind による） |
| `blobs` | 参照する blob ID（post のみ、最大 4） |
| `exp` | 期限。post は `ts + 7日` |
| `body` | kind ごとの公開フィールド |

### kind

| kind | body | ct | 誰が出せるか | deps |
|---|---|---|---|---|
| `group.create` | `kx`（作成者の X25519） | — | 誰でも | なし |
| `group.settings` | `hours?: [開始, 終了)`, `utcOffsetMin?` | `{name}` | 管理者 | 制御 heads |
| `invite` | `th = sha256(token)`, `exp?` | — | メンバー | 制御 heads |
| `invite.revoke` | `invite` | — | 管理者・招待した本人 | 制御 heads |
| `member.join` | `kx`, `invite`, `token` | — | token を持つ人 | `[invite]` を含む |
| `member.leave` | `successor?` | — | **本人のみ**。管理者は他メンバーがいれば `successor` 必須 | 制御 heads |
| `admin.transfer` | `to` | — | 管理者 | 制御 heads |
| `key.rotate` | `parent`（旧 epoch） | — | メンバー | 制御 heads + `parent` |
| `key.wrap` | `to`, `enc`, `ct`（HPKE） | — | メンバー | `[epoch, 対象の参加レコード]` |
| `profile` | — | `{name}` | メンバー | `[epoch]` |
| `post` | — | `{ck, mime, durationMs, takenAt}` | メンバー | `[epoch]` |

**他人を削除する操作は存在しない。** 制御レコード（上 8 種）はグループ状態を決め、無期限に保持する。`post` は 7 日で消える。

## グループ状態の導出

参照実装: `packages/core/src/membership.ts`。制御レコードの**集合**だけから決定的に計算し、到着順には依存しない。

1. deps による因果順のトポロジカルソート。同順位は `(ts, id)` の昇順。
2. 依存先が欠けているレコード（とその子孫）は **pending**（評価しない）。
3. 順に適用し、上の表の権限を満たさないものは **rejected**（無視）。
4. メンバー上限は 12。上限を超える参加は、この順序で後ろのものが rejected。
5. **現 epoch**：ルート（`group.create`）から、`parent` が同じ `key.rotate` のうち ID が最小の子を葉までたどる。
6. **ローテーション要否**：現 epoch の祖先（deps の推移閉包）に含まれない `member.leave` があれば、残りのメンバーの誰か（管理者は即時、他は 2 分後）が `key.rotate` を出し、残りの全員に `key.wrap` する。同時に複数出ても 5. で 1 つに決まり、他の epoch の鍵も配布済みなので読める。
7. 現 epoch の `key.wrap` を持たないメンバーがいれば、鍵を持つ端末が wrap する（管理者は即時、他は参加から 2 分後）。新規参加者に渡すのは現 epoch の鍵だけ。
8. 新しい epoch では各メンバーが `profile` を、管理者が `group.settings` を出し直す（古い鍵を持たない人のため）。

`protocol/test-vectors/` のベクタで、ID 計算・署名検証・導出結果を確認できる。

## HTTP API

すべて JSON。`Authorization: Bearer <token>` が必要なものは ★。

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/v1/health` | `{server_id, instance, time}`。`instance` は DB を作り直すと変わる |
| POST | `/v1/auth/challenge` | `{challenge}`（60 秒有効） |
| POST | `/v1/auth/token` | `{pk, challenge, sig}` → `{token, exp, peer}`（1 時間有効） |
| GET ★ | `/v1/me/groups` | 自分が現メンバーのグループ |
| POST ★ | `/v1/groups/:gid/records` | `{records: Envelope[]}`（最大 64）→ `{results}` |
| GET ★ | `/v1/groups/:gid/records?after=&limit=` | メンバーのみ。`{records, next, more}`。カーソルはサーバーごとの値 |
| POST ★ | `/v1/blobs/upload-url` | `{group, id, size}`（8MiB まで）→ `{stored}` または `{stored:false, url, headers}` |
| POST ★ | `/v1/blobs/download-url` | `{id}` → `{url}` |
| PUT/GET | `/v1/blobs/raw/:id?…` | 署名付き URL（サーバーが発行したもの）。R2 の presigned URL の場合もある |
| POST ★ | `/v1/push/subscribe`, `/v1/push/unsubscribe` | Web Push 購読 |
| ★ピア | `/v1/peer/records`, `/v1/peer/push-subs`, `/v1/peer/push-slots` | ピア間同期（設定されたピア鍵のみ） |

レコード投入の結果（1 件ごと）:

- `ok` / `dup`：保存した / すでにある
- `missing`：依存先がまだない（`missing` に ID。blob は `blob:<id>`）。**後で再送する**
- `invalid`：規則違反（`reason`）。再送しない

クライアントから直接届いたレコードは、作成者 = 認証した端末であること、メンバー規則、blob の到着をすべて確認する。
ピアから届いたレコードは署名・形式・deps の到着だけを確認し、規則は導出時に判定する（判断が食い違って同期が詰まらないように）。

## 同期

学内サーバーが 10 秒ごとに CF に対して行う（外向きのみ）:

1. `/v1/peer/records?after=` を pull して取り込み、足りない blob を取得する。
2. 未送信のレコード（`pushed = 0`）を、blob を先に送ってから push する。
3. Push 購読（`updated_at` の新しい方を採用）と送信済みの毎時スロットを双方向に同期する。
4. `/v1/health` の `instance` が変わっていたら（CF の DB を作り直したら）、カーソルを捨てて全件を送り直す。

## 通知

- VAPID 鍵は全ピアで共有する。通知の本文に内容は含めない（`{t:"prompt"}` / `{t:"post", g}`）。
- 新着通知は、レコードを**クライアントから直接受け取ったピアだけ**が送る。
- 毎時プロンプトは CF の Cron（毎時 0 分）が送る。学内は毎時 3 分を過ぎてもそのスロットが未送信（同期されていない）なら代わりに送る。
