# デプロイ手順

## 1. 鍵の生成

```sh
pnpm -F @knct-log/server-campus keygen
```

`SECRET`・ピア鍵・VAPID 鍵が表示される。

- 学内サーバーのピア**公開鍵** → CF の `PEER_KEYS`
- VAPID 鍵 → CF と学内の両方に**同じ値**を設定し、公開鍵は PWA の `VITE_VAPID_PUBLIC_KEY` にも渡す
- `SECRET` はサーバーごとに別の値でよい

## 2. Cloudflare（Hono on Workers）

```sh
cd servers/cf
wrangler d1 create knct-log          # 出力された database_id を wrangler.toml に書く
wrangler r2 bucket create knct-log-blobs
pnpm migrate:remote
wrangler secret put SECRET
wrangler secret put VAPID_PRIVATE_KEY
# wrangler.toml の [vars] に PEER_KEYS と VAPID_PUBLIC_KEY を書く
pnpm deploy
```

- 既定では blob を Worker 経由（R2 バインディング）でやりとりする。Worker を通さず R2 に直接アップロードさせたい場合は、R2 の API トークンを作って `R2_ACCOUNT_ID` / `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` を secret に設定し、バケットに CORS（PUT/GET、任意のオリジン）を設定する。
- 投稿は 7 日で期限切れになり、毎時の Cron で削除される。念のため R2 にもライフサイクルルール（8 日で削除）を設定しておく。

PWA は Cloudflare Pages に置く:

```sh
cd apps/pwa
VITE_ENDPOINTS="学内=https://campus.knct-log.example,Cloudflare=https://knct-log.<account>.workers.dev" \
VITE_VAPID_PUBLIC_KEY=... pnpm build
wrangler pages deploy dist
```

## 3. 学内サーバー（Hono on Node）

```sh
cp servers/campus/.env.example servers/campus/.env   # 値を埋める
docker compose -f servers/campus/compose.yaml up -d --build
```

Docker を使わない場合は `node servers/campus/src/main.ts`（Node 26 以上。`node:sqlite` と TypeScript の型除去を使う）。

### HTTPS（必須）

PWA は HTTPS で配信されるので、学内サーバーも HTTPS でないとブラウザが接続しない（混在コンテンツ）。

1. 自分のドメインのサブドメイン（例 `campus.knct-log.example`）を、学内サーバーの**プライベート IP** に向ける。
2. Let's Encrypt の **DNS-01** で証明書を取る（外から HTTP で到達できなくても取れる）。Caddy の DNS プラグインや `certbot --preferred-challenges dns` を使う。
3. リバースプロキシ（Caddy / nginx）で TLS を終端して `:3000` に転送する。

サーバーは Chrome の Private Network Access の preflight に `Access-Control-Allow-Private-Network: true` を返すので、公開オリジンの PWA から学内 IP に接続できる。

### CF 障害時にも学内だけで動かすために

- **DNS**：`campus.knct-log.example` の名前解決を Cloudflare DNS だけに頼らない。**学内 DNS にも同じレコードを登録する**か、Cloudflare 以外の DNS で管理する。
- **PWA**：Service Worker がアプリ全体をキャッシュしているので、一度開いた端末は CF Pages が落ちていても起動できる。障害中に新しくインストールする人のために、学内サーバーも PWA を配信している（`STATIC_DIR`）。ただしオリジンが違うので別アプリ扱いになり、鍵も別になる点に注意。
- **証明書**：90 日有効なので、短い障害では問題にならない。
- **毎時の通知**：CF が送れなかったスロットは、学内が 3 分後に代わりに送る（学内からインターネット上の Push サービスへ外向きで届く）。
- `PEER_URL` を設定しなければ、学内サーバーは CF なしの単独運用になる。

### 学内サーバーの環境変数

| 変数 | 内容 |
|---|---|
| `SECRET` | トークンと blob URL の HMAC 鍵（必須） |
| `PUBLIC_URL` | 外から見た URL（例 `https://campus.knct-log.example`）。blob の署名付き URL に使う |
| `PEER_URL` | CF の URL。未設定なら単独運用 |
| `PEER_SIGNING_KEY` | 学内サーバーのピア秘密鍵（PKCS#8, base64url） |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push |
| `DATA_DIR` | SQLite と blob の置き場所（既定 `./data`） |
| `STATIC_DIR` | PWA の `dist`（任意） |
| `PORT` | 既定 3000 |
| `SYNC_INTERVAL_MS` | 既定 10000 |
| `PROMPT_DELAY_MIN` | 毎時プロンプトを代わりに送るまでの分数（既定 3、単独運用なら 0） |
