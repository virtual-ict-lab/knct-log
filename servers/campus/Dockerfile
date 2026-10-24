# ビルドコンテキストはリポジトリのルート:  docker build -f servers/campus/Dockerfile .
# PWA の設定（接続先・VAPID 公開鍵・RP ID）はイメージに入れず、起動時の環境変数から /config.js で渡す
FROM node:26-slim AS build
RUN npm i -g pnpm@11.25.0
ENV CI=true
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm -F @knct-log/pwa build \
 && pnpm install --frozen-lockfile --prod --filter @knct-log/server-campus...

FROM node:26-slim
WORKDIR /app
COPY --from=build /app /app
ENV DATA_DIR=/data STATIC_DIR=/app/apps/pwa/dist PORT=3000
VOLUME /data
EXPOSE 3000
WORKDIR /app/servers/campus
CMD ["node", "src/main.ts"]
