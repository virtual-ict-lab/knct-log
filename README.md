# knct-log
alternative of setlog

## About this

香川高専詫間プロコン内で使用する予定のsetlog代替アプリ．

配信媒体はPWAと，.apk配布です．

- 1時間に1回、3秒だけ撮って、最大12人のグループで送り合う
- 動画・名前は**端末で E2E 暗号化**され、サーバーには中身が見えない
- 「まとめる」を押したときだけ、**端末上で** Vlog（1本の mp4）を作る
- サーバーは**学内（Node）と Cloudflare（Workers）の対等なピア**。学内では学内サーバー、学外では CF につながり、CF が落ちても学内だけで動き続ける
- 他人を削除する機能はない。退会は本人だけ。管理者は移譲できる
- 撮ったあとに動画の中央へ文字を入れられる。投稿には絵文字のリアクションと返信ができる
- アカウントは**パスキー**で作る。パスキーが同期されていれば新しい端末でもログインでき、ほかの端末の QR からも引き継げる（複数端末で同時に使える）

## 構成

```
protocol/             プロトコル仕様（README.md）とテストベクタ
packages/core/        暗号・レコード・メンバー状態の導出・API クライアント（TS 参照実装）
packages/conformance/ 両サーバーが満たすべき API 適合テスト
servers/app/          共通の Hono アプリ + SQL マイグレーション
servers/cf/           Cloudflare Workers（D1 + R2 + Cron）
servers/campus/       学内サーバー（Node + SQLite + ローカルディスク）と CF への同期
apps/pwa/             React + Vite の PWA
docs/                 デプロイ手順・脅威モデル
```

## 開発

Node 26 と pnpm 12（`mise install` で入る）。

```sh
pnpm install
pnpm test        # core / campus（同期・CF 障害のシナリオを含む）/ pwa
pnpm typecheck

# CF（ローカルの D1 / R2）
cd servers/cf && cp .dev.vars.example .dev.vars && pnpm migrate:local && pnpm dev   # :8787
# CF に対して適合テスト
TARGET_URL=http://127.0.0.1:8787 pnpm -F @knct-log/conformance test:remote

# 学内サーバー（単独運用）
SECRET=dev node servers/campus/src/main.ts                                          # :3000

# PWA
VITE_ENDPOINTS="学内=http://127.0.0.1:3000,Cloudflare=http://127.0.0.1:8787" pnpm -F @knct-log/pwa dev
```

### スマホで確認する

カメラ・パスキー・暗号（`crypto.subtle`）は HTTPS（か `localhost`）でしか使えず、パスキーは IP アドレスでは作れない。`http://192.168.x.x:5173` のように開くと動かないので、Tailscale の `serve` で `https://<マシン名>.<tailnet>.ts.net` として開く（スマホも同じ tailnet に入れる）。

```sh
HOST=$(tailscale status --self --json | jq -r '.Self.DNSName | rtrimstr(".")')
# set HOST (tailscale status --self --json | jq -r '.Self.DNSName | rtrimstr(".")')
tailscale serve --bg --https=443 5173     # PWA
tailscale serve --bg --https=8443 3000    # 学内サーバー

SECRET=dev PUBLIC_URL=https://$HOST:8443 node servers/campus/src/main.ts
VITE_ENDPOINTS="学内=https://$HOST:8443" pnpm -F @knct-log/pwa dev
# スマホで https://$HOST を開く。終わったら tailscale serve reset
```

`VITE_RP_ID` は設定しない（開いているホスト名がパスキーの RP ID になる）。ホスト名が変わると、そのパスキーではログインできない。

デプロイは [docs/campus-deploy.md](docs/campus-deploy.md)、プロトコルは [protocol/README.md](protocol/README.md) を参照。
