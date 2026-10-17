# knct-log プロトコル v1

サーバー実装（Hono on Workers / Hono on Node）とクライアント実装（PWA、今後の Kotlin 版）が共有する仕様。
TypeScript の参照実装は `packages/core`、API の適合テストは `packages/conformance` にある。

## 基本方針

- **E2E 暗号化は端末で行う。** サーバーは「署名の検証・暗号文の保管と配布・Push」だけを担当し、動画・名前・撮影時刻は読めない。
- **データはすべて、クライアントが署名した不変レコード。** ID は内容ハッシュなので、複数サーバーが別々に受け付けても和集合で合流できる。
- **アカウント = 端末間で共有する鍵。** グループのメンバーはアカウントの公開鍵で表す。鍵はパスキー（PRF）で暗号化してサーバーに置き、同じパスキーがあればどの端末でも取り出せる。
- **サーバーは対等なピア。** 学内サーバーと Cloudflare のどちらも正本ではなく、単独で書き込みを受け付ける。同期は学内側からの外向き通信だけで行う。

## エンコーディング

- バイナリはすべて **base64url（パディングなし）**。
- 公開鍵・ID・ハッシュは 32 バイト（43 文字）。グループ ID は 16 バイト乱数（22 文字）。
- 時刻は UNIX ミリ秒。

## 暗号

| 用途 | 方式 |
|---|---|
| アカウントの署名鍵 | Ed25519（raw 公開鍵 32B） |
| アカウントの鍵共有鍵 | X25519（raw 公開鍵 32B） |
| アカウント鍵の保管 | bundle = AES-256-GCM(AMK, JSON)、AAD = `knct-log/v1/account/<account>/bundle`。AMK はアカウントごとの乱数 32B |
| AMK の保管 | unlock.box = AES-256-GCM(KEK, AMK)、AAD = `knct-log/v1/account/<account>/unlock/<unlock id>` |
| KEK | HKDF-SHA256(ikm, salt = 空, info = `knct-log/v1/unlock/<passkey|link>`) → 32B。ikm はパスキーの PRF 出力、またはリンクの乱数 32B |
| パスキーの PRF | WebAuthn PRF 拡張（CTAP の hmac-secret）。salt = UTF-8 `knct-log/v1/prf`（全アカウント共通） |
| グループ鍵の配布 | HPKE RFC 9180 base mode, `DHKEM(X25519, HKDF-SHA256)` / `HKDF-SHA256` / `AES-256-GCM`, info = `knct-log/v1/key.wrap/<group>/<epoch>` |
| レコードの暗号文 `ct` | AES-256-GCM（鍵 = epoch のグループ鍵 32B）。出力 = `nonce(12) ‖ ciphertext ‖ tag`。AAD = `knct-log/v1/<group>/<kind>/<epoch>/<author>` |
| 動画 blob | AES-256-GCM（鍵 = クリップごとの乱数 `ck` 32B）、AAD = `knct-log/v1/blob`。blob ID = `sha256(暗号文)` |
| 認証 | Ed25519 で `knct-log/v1/auth:<challenge>` に署名 |

端末に取り込んだ秘密鍵は non-extractable（WebCrypto / Android Keystore）にする。取り出せるのは、AMK を持つ端末が bundle を開いたときだけ。

## アカウント

1 人 = 1 アカウント = Ed25519 + X25519 の鍵ペア 1 組。複数の端末が同じ鍵を使うので、グループの規則（メンバー・鍵の wrap・投稿制限）は端末の数に関係なく 1 人として扱われる。

**アカウント文書**（`{payload, sig}` 形式、アカウントの Ed25519 で署名。payload は 32KiB まで）:

```json
{ "v": 1, "account": "<Ed25519 公開鍵>", "ts": 1800000000000,
  "bundle": "<AES-GCM(AMK, {v, signPkcs8, kxPkcs8, signPub, kxPub, name, icon?})>",
  "unlocks": [ { "id": "<credential ID>", "kind": "passkey", "box": "<AES-GCM(KEK, AMK)>" },
               { "id": "<乱数>", "kind": "link", "exp": 1800000600000, "box": "…" } ] }
```

- `signPkcs8` / `kxPkcs8` は PKCS#8 DER（base64url）。`name` は表示名（各グループの `profile` の元）。
- unlocks は 16 個まで。`link` は 10 分で期限切れ（使ったら消す）。
- サーバーは `ts` が新しいものだけを受け付ける（LWW）。署名者 = `account` であることを確認する。中身は暗号文なので、取得に認証は要らない。

**作成**：鍵ペアと AMK を作り、パスキーを登録する（`user.id` = アカウントの公開鍵 32B、resident key 必須、PRF を評価）。PRF 出力から KEK を導出して AMK を包み、文書を公開する。パスキーを使えない端末では unlock なしで作れる（その端末だけで使える）。

**パスキーでログイン**：discoverable な `navigator.credentials.get` で PRF を評価する。返ってきた `userHandle` がアカウントの公開鍵なので、どのサーバーからでも文書を取得し、`credential ID` が一致する unlock を開く。パスキーが Google パスワードマネージャーや iCloud キーチェーンで同期されていれば、新しい端末でもそのままログインできる。RP ID は PWA の配信元と学内サーバーで共通の親ドメインにする（`VITE_RP_ID`）。

**QR で引き継ぎ**：既存の端末が乱数 32B のリンク用 unlock を追加して公開し、`<app>/#/link?a=<account>&u=<unlock id>&k=<乱数>` を QR で表示する（フラグメントなのでサーバーには送られない）。新しい端末はこれを読んで文書を開き、使った unlock を消す。

**変更**（名前・パスキーの追加）：サーバーの最新の文書に変更を当て、`ts` を進めて署名し直す。409 なら取り直してやり直す。各端末は同期のたびに文書を取得し、他の端末での変更を取り込む。

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
| `group.settings` | `hours?: [開始, 終了)`, `utcOffsetMin?`, `editableBy?: "admin"｜"members"` | `{name, icon?}` | 管理者。`editableBy` が `"members"` のときは他のメンバーも、ただし body が空（名前とアイコンだけ）のものに限る | 制御 heads |
| `invite` | `th = sha256(token)`, `exp?` | — | メンバー | 制御 heads |
| `invite.revoke` | `invite` | — | 管理者・招待した本人 | 制御 heads |
| `member.join` | `kx`, `invite`, `token` | — | token を持つ人 | `[invite]` を含む |
| `member.leave` | `successor?` | — | **本人のみ**。管理者は他メンバーがいれば `successor` 必須 | 制御 heads |
| `admin.transfer` | `to` | — | 管理者 | 制御 heads |
| `key.rotate` | `parent`（旧 epoch） | — | メンバー | 制御 heads + `parent` |
| `key.wrap` | `to`, `enc`, `ct`（HPKE） | — | メンバー | `[epoch, 対象の参加レコード]` |
| `profile` | — | `{name, icon?}` | メンバー | `[epoch]` |
| `post` | — | `{ck, mime, durationMs, takenAt, text?, w?, h?}` | メンバー | `[epoch]` |
| `reaction` | `to`（投稿者） | `{ref, emoji}` | メンバー | `[epoch]` |
| `reply` | `to`（投稿者） | `{ref, text}` | メンバー | `[epoch]` |
| `post.edit` | — | `{ref, text}` | メンバー（表示に使うのは投稿者本人のものだけ） | `[epoch]` |
| `post.delete` | `post`（投稿 ID） | — | **投稿者本人のみ** | `post` を含む |

**他人を削除する操作は存在しない。** 自分の投稿だけは `post.delete` で消せる。 制御レコード（上 8 種）はグループ状態を決め、無期限に保持する。`post` は 7 日で消える。

- **名前とアイコン**：グループの名前・アイコンは `group.settings` の `ct`、メンバー自身の表示名・アイコンは `profile` の `ct` に入れる。`icon` は小さな画像の data URL（`data:image/(webp|jpeg|png);base64,...`、全体で 9000 文字まで。目安は 128×128 の WebP で 6KB 以下）。blob は 7 日で消えるので使わず、レコードに埋め込む（payload 16KiB の上限に収める）。
- **誰が名前・アイコンを変えられるか**：既定は管理者のみ。管理者が `group.settings` の `body.editableBy` を `"members"` にすると、メンバーなら誰でも `body` が空の `group.settings`（名前とアイコンだけ）を出せる。`hours` / `utcOffsetMin` / `editableBy` を含むレコードは常に管理者のみ（`editableBy` を変えられるのは管理者だけ）。権限はレコードを導出順に適用する時点の `editableBy` で判定するので、設定の切り替えと同時に出されたレコードも到着順に依らず同じ結果になる。最後に適用された `group.settings` の `ct` が現在の名前・アイコン。旧実装は管理者以外の `group.settings` を無視するので、`editableBy` は旧クライアントには効かない（読む側は影響を受けない）。
- 自分のアイコンは名前と同じくアカウント文書の bundle（`AccountSecret.icon?`）に入れて端末間で引き継ぎ、各グループの `profile` として出し直す。bundle の上限は 16384 文字。
- `post.text` は動画の中央に重ねる文字（40 文字まで）。動画には焼き込まず、表示時に重ね、Vlog を作るときだけ焼き込む。
- `post.w` / `post.h` は表示したときの動画の幅と高さ（回転を反映した画素数）。現在のクライアントは端末の向きによらず横動画（1280×720、カメラ映像の中央を 16:9 に切り抜く）だけを撮る。読み込む前に並べ方を決めるためのもので、無いとき（旧クライアント）は縦長 9:16 とみなし、動画を読み込んだあとの実際の大きさで並べ直す。
- `reaction` / `reply` の `exp` は対象の投稿と同じ（投稿と一緒に消える）。`ref`（対象の投稿 ID）は暗号文の中なので、サーバーにはどの投稿への反応かは分からない。`to` は通知の宛先にだけ使う。
- `post.edit` は投稿の文字（`post.text`）を置き換える。投稿者本人のもののうち最新（`(ts, id)` が最大）が有効で、`text` が空文字なら文字を消す。`ref` は暗号文の中なので、サーバーは作成者を確認できない（他人のものは表示側で無視する）。`exp` は対象の投稿と同じ。
- `post.delete` は投稿を消す。サーバーが動画を消せるよう、対象の投稿 ID を `body.post` で公開する（`ct` と `epoch` はなし、`exp` は対象の投稿と同じ）。クライアントから直接届いたものは、対象が同じグループ・同じ作成者の `post` でなければ invalid。受け付けたサーバー（ピアから届いた場合も、対象の作成者が一致すれば）は動画の blob をすぐに消す。投稿のレコードは期限まで残し、表示側が隠す。
- `reaction` は作成者ごと・投稿ごとに最新（`(ts, id)` が最大）の 1 つが有効。`emoji` が空文字なら取り消し。`reply.text` は 200 文字まで。

## グループ状態の導出

参照実装: `packages/core/src/membership.ts`。制御レコードの**集合**だけから決定的に計算し、到着順には依存しない。

1. deps による因果順のトポロジカルソート。同順位は `(ts, id)` の昇順。
2. 依存先が欠けているレコード（とその子孫）は **pending**（評価しない）。
3. 順に適用し、上の表の権限を満たさないものは **rejected**（無視）。
4. メンバー上限は 12。上限を超える参加は、この順序で後ろのものが rejected。
5. **現 epoch**：ルート（`group.create`）から、`parent` が同じ `key.rotate` のうち ID が最小の子を葉までたどる。
6. **ローテーション要否**：現 epoch の祖先（deps の推移閉包）に含まれない `member.leave` があれば、残りのメンバーの誰か（管理者は即時、他は 2 分後）が `key.rotate` を出し、残りの全員に `key.wrap` する。同時に複数出ても 5. で 1 つに決まり、他の epoch の鍵も配布済みなので読める。
7. 現 epoch の `key.wrap` を持たないメンバーがいれば、鍵を持つ端末が wrap する（管理者は即時、他は参加から 2 分後）。新規参加者に渡すのは現 epoch の鍵だけ。
8. 新しい epoch では各メンバーが `profile` を、管理者が（最後に適用された内容の）`group.settings` を出し直す（古い鍵を持たない人のため）。

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
| GET | `/v1/accounts/:account` | アカウント文書 `{payload, sig}`。なければ 404 |
| PUT | `/v1/accounts` | アカウント文書を保存。署名不正は 400、`ts` が古いと 409 |
| ★ピア | `/v1/peer/records`, `/v1/peer/push-subs`, `/v1/peer/push-slots`, `/v1/peer/accounts` | ピア間同期（設定されたピア鍵のみ） |

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
3. Push 購読（`updated_at` の新しい方を採用）、送信済みの毎時スロット、アカウント文書（`ts` の新しい方を採用、署名はそれぞれのサーバーで検証）を双方向に同期する。
4. `/v1/health` の `instance` が変わっていたら（CF の DB を作り直したら）、カーソルを捨てて全件を送り直す。

## 通知

- VAPID 鍵は全ピアで共有する。通知の本文に内容は含めない（`{t:"prompt"}` / `{t:"post", g}`）。
- 新着通知は、レコードを**クライアントから直接受け取ったピアだけ**が送る。`reaction` / `reply` は `to` の人にだけ `{t:"reaction"|"reply", g}` を送る。
- 毎時プロンプトは CF の Cron（毎時 0 分）が送る。学内は毎時 3 分を過ぎてもそのスロットが未送信（同期されていない）なら代わりに送る。
